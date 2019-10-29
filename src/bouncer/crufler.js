'use strict'

const mongoose = require('mongoose')
const MongoQuery = require('./mongo-query.js')
const debug = require('debug')('bouncer-db.crufler')

/**
 * crufler exposes interface to crufl ops
 *
 * - can be subclassed to control access to data
 */
module.exports = class Crufler {

  constructor ({ actor, type, collection, context }) {
    this.actor = actor
    this.type = type
    this.collection = collection
    this.context = context
  }

  // validate msg $meta type & id
  isValid (msg) {
    return msg
      && typeof msg === 'object'
      && msg.$meta
      && typeof msg.$meta === 'object'
      && msg.$meta.type === this.type
      && typeof msg.$meta.id === 'string'
  }

  // generate mongo object id from message or die trying
  getOid (msg) {

    // attempt to generate oid
    try {
      return new mongoose.Types.ObjectId(msg.$meta.id)

    // on failure throw malformed msg error
    } catch (error) {
      debug(
        `failed to create mongo id from msg ${JSON.stringify(msg)} ->`,
        error
      )
      throw new Error('MessageFail: malformed id')
    }
  }

  genMeta (msg, removed) {
    const $meta = {
      type: this.type,
      id: msg._id,
      version: msg.__v
    }
    /*if (!!msg.__v) {
      $meta.version = msg.__v
    }*/
    if (removed) {
      $meta.removed = true
    }
    return $meta
  }

  // *** override can* & redact* & filter* methods to control access ***

  /** return true to allow new messages to be written to current collection */
  async canNew (msg) {
    return false
  }

  /** return true to allow given message to be changed (updated | removed) */
  async canChange (msg, newMsg) {
    return false
  }

  /** return true to allow given message to be read (found | looked up) */
  async canRead (msg) {
    debug('hit canRead')
    return false
  }

  /** filter query spec before finding msgs */
  filterQuerySpec (spec) {
    return spec
  }

  /** clean data party client messages before writing to db */
  redactWrite (msg) {
    const {
      _id, __v, $meta, // strip mongodb & data party metadata
      owner, admin, members, devices, // strip acl fields unless we check them
      ...rawMsg
    } = msg || {}
    throw new Error('crufler subclass must implement redactWrite(msg)')
  }

  /** clean messages coming from mongo db */
  redactRead (msg) {

    // validate that msg is non-null object
    if (msg === null || typeof msg !== 'object') {
      return {}
    }

    // get plain object from mongoose document
    const redactedMsg = typeof msg.toObject === 'function'
      ? msg.toObject()
      : Object.assign({}, msg)

    return redactedMsg
  }

  // *** crufler exposes crufl interface for given message collection ***

  // freshen collection with crufl & return result
  // * sets error.result on failure
  async freshen (crufl) {

    const result = {
      op: crufl.op,
      type: this.type,
      uuid: crufl.uuid,
      complete: true
    }

    // call op & set result messages
    switch (crufl.op) {

    case 'create':
    case 'remove':
    case 'update':
    case 'lookup':
      try {

        // if no messages given dont call op handler
        if (!crufl.msgs || crufl.msgs.length < 1) {
          result.error = 'CheckFail: no messages' // malformed check request

        // if there are messages call op handler to freshen them
        } else {
          result.msgs = await this[crufl.op](crufl.msgs)
        }

      // if op handler rejects set error message on crufl result
      } catch (error) {
        result.error = error.message
      }

      return result

    case 'find':
      try {
        result.msgs = await this.find(crufl.spec)

      // if find rejects set error message on crufl result
      } catch (error) {
        result.error = error.message
      }

      return result

    default:
      debug(`cant freshen with unexpected crufl op '${crufl.op}'`)
      result.error = 'CheckFail' // malformed check request
      return result
    }
  }

  // either creates *all* of the messages or rejects
  async create (msgs) {

    // reject with permission fail error if client cant new every message
    const permitted = await Promise.all(msgs.map(msg => this.canNew(msg)))
    if (!permitted.every(x => x)) {
      return Promise.reject(new Error('PermissionFail'))
    }

    // guard call to mongodb create
    let mgoMsgs
    try {

      // create list of prepped msgs to write to backend
      const preppedMsgs = msgs.map(msg => this.redactWrite(msg))

      // creates new msgs in one call & gets mongo msgs with ids back
      mgoMsgs = await this.collection.insertMany(preppedMsgs)

    // TODO -> distinguish bouncer & schema failure
    } catch (error) {
      debug('failed to create msgs ->', msgs, '->', error)
      return Promise.reject(new Error('SchemaFail'))
    }

    if (!mgoMsgs || mgoMsgs.length !== msgs.length) {
      debug('mgo create returned malformed msgs ->', mgoMsgs)
      return Promise.reject(new Error('BouncerFail'))
    }

    // redact newly created messages & set $meta before returning
    return mgoMsgs.map(
      msg => Object.assign(
        {
          $meta: this.genMeta(msg)
        },
        this.redactRead(msg)
      )
    )
  }

  async remove (msgs) {

    // validate msg before adding to oid map
    const outMsgs = []
    const oidMap = {}
    for (const msg of msgs) {
      if (this.isValid(msg)) {
        const outMsg = {
          $meta: {
            type: this.type,
            id: msg.$meta.id,
            error: 'IdFail'
          }
        }
        outMsgs.push(outMsg)
        oidMap[this.getOid(msg)] = outMsg
      }
    }

    // find messages by oid map keys & remove each
    for (const mgoMsg of await this.findByOid(Object.keys(oidMap))) {

      debug('found msg in db: ' + JSON.stringify(mgoMsg))

      const outMsg = oidMap[mgoMsg._id] // find output msg with id
      if (outMsg) {

        // if actor doesnt have change privilege set error to permission fail
        if (!await this.canChange(mgoMsg, mgoMsg)) {
          outMsg.$meta.error = 'PermissionFail'

        // otherwise attempt to remove msg
        } else {
          try {
            await mgoMsg.remove()

            debug('removed msg: ' + JSON.stringify(mgoMsg, null, 2))

            // on successful removal
            // * merge latest version of msg from db
            // * overwrite initial meta tag
            Object.assign(
              outMsg,
              this.redactRead(mgoMsg),
              { $meta: this.genMeta(mgoMsg, true) } // set removed flag
            )

          } catch (error) {
            debug(`failed to remove msg ${this.type} ${mgoMsg._id} ->`, error)
            outMsg.$meta.error = 'BouncerFail'
          }
        }
      }
    }

    return outMsgs
  }

  async update (msgs) {

    // clone msgs & build maps by mongo oid of msgs with validated type
    const inMsgs = []
    const outMsgs = []
    const inMap = {}
    const outMap = {}
    for (const msg of msgs) {
      if (this.isValid(msg)) {
        const oid = this.getOid(msg)
        const outMsg = {
          $meta: {
            type: this.type,
            id: msg.$meta.id,
            error: 'IdFail'
          }
        }
        outMsgs.push(outMsg)
        outMap[oid] = outMsg
        const inMsg = this.redactWrite(msg)
        inMsgs.push(inMsg)
        inMap[oid] = inMsg
      }
    }

    // find messages by oid map keys & update each
    for (const mgoMsg of await this.findByOid(Object.keys(inMap))) {

      debug('found msg in db: ' + JSON.stringify(mgoMsg))

      // validate returned message matches id of message in input map
      if (
        mgoMsg !== null
        && typeof mgoMsg === 'object'
        && '_id' in mgoMsg
        && mgoMsg._id in inMap
      ) {
        const inMsg = inMap[mgoMsg._id]
        const outMsg = outMap[mgoMsg._id]

        // can change needs old & new msg
        const oldMsg = mgoMsg.toObject()
        Object.assign(mgoMsg, inMsg) // inMsg _id stripped by redactWrite()

        // if client doesnt have permission set permission fail error
        if (!(await this.canChange(oldMsg, mgoMsg))) {
          outMsg.$meta.error = 'PermissionFail'

        // update values in mongoose document & write changes to db
        } else {
          try {
            mgoMsg.increment()
            const updatedMgoMsg = await mgoMsg.save()

            // write fresh redacted data to outMsgs
            // * overwrite meta key with updated metadata
            Object.assign(
              outMsg,
              this.redactRead(updatedMgoMsg),
              { $meta: this.genMeta(updatedMgoMsg) }
            )

          // TODO -> distinguish between bouncer & schema failures
          } catch (error) {
            debug(
              `failed to update message ${this.type} ${mgoMsg._id} ->`,
              error
            )
            outMsg.$meta.error = 'BouncerFail'
          }
        }
      }
    }

    return outMsgs
  }

  async lookup (msgs) {

    // clone msgs & build maps by mongo oid of msgs with validated type
    const outMsgs = []
    const outMap = {}
    for (const msg of msgs) {

      // validate message type & id
      if (!this.isValid(msg)) {
        debug('cant lookup malformed message ->', JSON.stringify(msg))
        return Promise.reject(new Error('MessageFail: malformed message'))
      }

      // attempt to generate mongo id from id string
      const oid = this.getOid(msg)

      // create initial output message with error set to id fail & add to map
      const outMsg = {
        $meta: {
          type: this.type,
          id: msg.$meta.id,
          error: 'IdFail'
        }
      }
      outMsgs.push(outMsg)
      outMap[oid] = outMsg
    }

    // find messages by oid map keys & update each
    for (const mgoMsg of await this.findByOid(Object.keys(outMap))) {
      debug('*** lookup found msg ->', mgoMsg)

      if (
        mgoMsg !== null
        && typeof mgoMsg === 'object'
        && '_id' in mgoMsg
        && mgoMsg._id in outMap
      ) {
        const outMsg = outMap[mgoMsg._id]

        // write fresh redacted data to outMsgs
        // * overwrite meta key with fresh metadata
        Object.assign(
          outMsg,
          this.redactRead(mgoMsg),
          { $meta: this.genMeta(mgoMsg) }
        )

        debug('*** redacted msg ->', mgoMsg)
      } else {
        debug('*** lookup ignoring msg', mgoMsg)
      }
    }

    return outMsgs
  }

  async find (spec) {
    try {
      const msgs = [] // for returned metamsgs

      // create mongo query from filtered spec
      const mgoSpec = new MongoQuery(await this.filterQuerySpec(spec))
      const queryDoc = mgoSpec.getQueryDoc()

      debug(`queryDoc -> ${JSON.stringify(queryDoc)}`)

      let query = this.collection.find(queryDoc)

      // limit & sort query
      if (mgoSpec.hasLimit()) {
        query = query.limit(mgoSpec.getLimit())
      }
      if (mgoSpec.hasSort()) {
        query = query.sort(mgoSpec.getSort())
      }

      // only get msg metadata (_id & owner)
      query = query.select({ _id: 1, __v: 1, owner: 1 })

      // loop over results of async exec query & add meta msg to return list
      for (const mgoMsg of await query.exec()) {
        if (await this.canRead(mgoMsg)) {
          const { _id: id, __v: version } = this.redactRead(mgoMsg)
          if (id) {
            msgs.push({ $meta: { type: this.type, id, version } })
          }
        }
      }

      return msgs

    // TODO -> distinguish between query spec failure & general bouncer failure
    } catch (error) {
      debug(`query with spec ${JSON.stringify(spec)} failed ->`, error)
      return Promise.reject(new Error('QueryFail'))
    }
  }

  async findByOid (oids) {

    // create mongo query from filtered spec with just ids
    const mgoSpec = new MongoQuery(
      await this.filterQuerySpec({
        ids: oids
      })
    )
    const queryDoc = mgoSpec.getQueryDoc()

    debug(`queryDoc -> ${JSON.stringify(queryDoc)}`)

    const query = this.collection.find(queryDoc)

    // return promise resolving to list of msgs matching keys
    const msgs = await query.exec()

    debug('find oids', oids)
    debug('testing can reads against', JSON.stringify(msgs))

    // apply read filter to messages before returning
    // * build list of permitted flags & resolve promises in parallel
    // * shift flags off of permitted list to filter found messages list
    const permitted = await Promise.all(msgs.map(msg =>{
      debug('testing permitted')
      return this.canRead(msg)
    }))
    
    return msgs.filter(() => permitted.shift())
  }

  // set current actor as owner of given message
  own (msg) {
    return Object.assign(
      (msg !== null && typeof msg === 'object') ? msg : {},
      { owner: { type: this.actor.type, id: this.actor.id } })
  }

  // returns true if current actor is registered as owner of given msg
  owns (msg) {
    return (
      msg !== null
      && typeof msg === 'object'
      && 'owner' in msg
      && msg.owner.type && this.actor.type
      && msg.owner.type === this.actor.type
      && msg.owner.id && this.actor.id
      && msg.owner.id.toString() === this.actor.id.toString()
    )
  }
}

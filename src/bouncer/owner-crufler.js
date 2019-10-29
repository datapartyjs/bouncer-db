'use strict'

const mongoose = require('mongoose')
const Crufler = require('./crufler.js')
const debug = require('debug')('bouncer-db.owner-crufler')
let Acl = undefined

/** owner-crufler extends crufler to give message owners read & write */
module.exports = class OwnerCrufler extends Crufler {

  constructor ({ actor, permissions, type, collection, collections }) {
    super({ actor, type, collection })

    Acl = mongoose.model('api_acl')

    this.collections = collections
    this.acl = undefined
    this.permissions =
      (permissions !== null && typeof permissions === 'object')
        ? {
          read: Boolean(permissions.read),
          new: Boolean(permissions.new),
          change: Boolean(permissions.change)
        }
        : {
          read: false,
          new: false,
          change: false
        }
    debug(`new crufler: ${JSON.stringify(this)}`)
  }

  /** limit queries to messages owned by current actor */
  async filterQuerySpec (spec) {


    debug(`input query spec -> `, JSON.stringify(spec,null,2))

    let filters = undefined

    // dont inject acl actors into acl msgs
    if (this.type === 'acl') {
      debug('acl query, no filter')
      return spec
    }
    else if(this.type === this.actor.type){
      debug('actor query, no filter')
      return spec
    }
    else if(this.actor.actors){

      debug('applying actors filter')

      filters = []

      for(let actor of this.actor.actors){


        let pushFilter = (field)=>{
          debug('applying actor filter - ', actor.type, actor.id, )

          filters.push({
            op: 'and',
            match: [
              {op: 'equals', param: [field, 'id'], value: actor.id},
              {op: 'equals', param: [field, 'type'], value: actor.type}
            ]
          })
        }

        if(this.type === actor.type && spec.ids && spec.length == 1 ){
          filters.push({
            op: 'equals',
            param: ['id'],
            value: actor.id
          })
        }

        if(actor.owner || actor.type == 'user' || actor.type == 'identity' || actor.type == 'device'){
          pushFilter('owner')
        }

        if(actor.admins){
          pushFilter('admins')
        }

        if(actor.members){
          pushFilter('members')
        }

        if(actor.devices){
          pushFilter('devices')
        }
      }


      let resourceType = (this.type && this.type != 'acl') ? this.type : undefined
      let resources = await Acl.aclResourcesByActors(this.actor.actors, resourceType, 'read')

      debug('acl for type', resourceType || '*')
      debug('actor has # acl resources =', resources.length)
      debug(resources)

      let docFilter = resources.map(resource=>{
        filters.push({
          op: 'equals',
          param: ['_id'],
          value: (this.type != 'acl') ? resource.resource.id : resource._id
        })
      })
    }


    if(!filters || filters.length < 1){
      spec.owner = {
        type: this.actor.type,
        id: this.actor.id
      }
    }
    else {
      if(!spec.match || spec.match.length < 1){
        spec.match = [{
          op: 'or',
          match: filters
        }]
      }
      else{
        debug(typeof spec.match)
        debug(Array.isArray(spec.match))
        debug(JSON.stringify(spec.match,null,2))
        spec.match = [{
          op:'and',
          match: [{
            op: 'or',
            match: filters
          }].concat(spec.match)
        }]
      }

    }

    debug(`filtered query spec -> `, JSON.stringify(spec,null,2))

    return spec
  }

  isAllowedCollection(name){
    if(name == 'acl'){ return false }

    debug('collection names', Object.keys(this.collections))

    return Object.keys(this.collections).indexOf(name) > -1
  }

  /** allow message to be read if current actor owns it OR has ACL permission */
  async canRead (msg) {

    //! Allow if owner/admins OR if members/devices
    debug('canRead crufler.type', this.type, 'actor.type', this.actor.type)

    if(this.type == this.actor.type){
      debug('canRead - collection is same type as actor')
      if(this.actor.id == msg.id.toString()){
        debug('canRead - message is same id as actor')
        return true
      }
    }
    else if(this.type == 'acl'){
      debug('detected ACL READ')
      debug(JSON.stringify(msg,null,2))


      let acl = await Acl.findById(msg._id).exec()

      if(!acl){ return false }

      let allowed = acl.isAllowed(this.actor, 'read', '')

      if(!allowed){
        //! check if they own resource

        let resourceId = acl.resource.id
        let resourceType = acl.resource.type

        if(!this.isAllowedCollection(resourceType)){
          debug('deny - ACL resource[',resourceType,'] is not an allowed collection')
          return false
        }

        let collectionPerms = await this.collections[resourceType].permissions(this.context)

        debug('collection permissions -> ', collectionPerms)

        let resource = await this.collections[resourceType].findById(resourceId).exec()

        debug('acl read resource -> ', resource)

        //! Allow if you are owner or member of resource
        allowed = collectionPerms.read && (
          Acl.isOwner(resource, this.actor) ||
          Acl.isMember(resource, 'members', this.actor) ||
          Acl.isMember(resource, 'devices', this.actor)
        )
      }

      debug('allow acl read ->', allowed)

      return allowed
    }

    let allow = this.permissions.read && (
      Acl.isOwner(msg, this.actor) ||
      Acl.isMember(msg, 'members', this.actor) ||
      Acl.isMember(msg, 'devices', this.actor)
    )

    if(!allow){
      let acl = await Acl.aclByResource(msg._id, this.type).exec()
      if(acl){
        allow |= this.permissions.read && acl.isAllowed(this.actor, 'read', '')
      }
    }

    return allow
  }

  /** allow collection to be written to if 'new' permissions flag is set */
  async canNew (msg) {


    if(this.type == 'acl'){
      debug('detected ACL NEW')

      if(!msg){ return true }

      let resourceId = msg.resource.id
      let resourceType = msg.resource.type

      if(!this.isAllowedCollection(resourceType)){
        debug('deny - ACL resource is not an allowed collection')
        return false
      }

      let acl = await Acl.aclByResource(resourceId, resourceType).exec()

      if(acl){
        debug(JSON.stringify(acl, null, 2))
        debug('deny - duplicate ACL')
        return false
      }

      let collectionPerms = await this.collections[resourceType].permissions(this.context)
      let resource = await this.collections[resourceType].findById(resourceId).exec()

      debug('acl new resource -> ', resource)

      let allowed = /*collectionPerms.new &&*/ Acl.isOwner(resource,this.actor)

      debug('allow acl new ->', allowed)

      return allowed
    }

    if(!msg){
      return  this.permissions.new
    }

    //! Allow if owner
    return this.permissions.new && Acl.isOwner(msg,this.actor)
  }

  /** allow message to be changed if current actor owns it */
  async canChange (msg, newMsg) {

    debug('canChange type', this.type)

    if (this.type == this.actor.type && this.actor.id == newMsg.id) {
      return this.permissions.change
    }
    else if (this.type === 'acl') {
      debug('request for acl change')

      debug('existing acl ->', JSON.stringify(msg))
      debug('new acl ->', JSON.stringify(newMsg))

      // force resource ids to be strings
      const resourceId = msg.resource && msg.resource.id
        ? msg.resource.id.toString()
        : undefined
      const resourceType = msg.resource.type
      const newResourceId = newMsg.resource && newMsg.resource.id
        ? newMsg.resource.id.toString()
        : undefined
      const newResourceType = newMsg.resource.type

      if (!this.isAllowedCollection(resourceType)) {
        debug('deny - acl resource is not an allowed collection')
        return false
      }

      if (resourceId !== newResourceId || resourceType !== newResourceType) {
        debug(
          'deny - attempt to change acl document resource',
          {
            resourceId,
            newResourceId,
            resourceType,
            newResourceType,
            'resourceId === newResourceId': resourceId === newResourceId,
            'resourceType === newResourceType':
              resourceType === newResourceType,
          }
        )
        return false
      }

      const collectionPerms = await this.collections[resourceType].permissions(this.context)

      debug('collection permissions -> ', collectionPerms)

      const resource = await this.collections[resourceType]
        .findById(resourceId)
        .exec()

      debug('acl change resource -> ', resource)

      const allowed = (collectionPerms.change || collectionPerms.read)
        && Acl.isOwner(resource, this.actor)

      debug('allow acl change ->', allowed)

      return allowed
    }

    let allow = this.permissions.change
      && Acl.isOwner(msg, this.actor)
      && Acl.isOwner(newMsg, this.actor)

    if (!allow) {
      const Acl = mongoose.model('api_acl')
      const acl = await Acl.aclByResource(msg._id, this.type).exec()
      if (acl) {
        allow |= this.permissions.change
          && acl.isAllowed(this.actor, 'change', '')
      }
    }

    return allow
  }

  redactWrite (msg) {
    const { _id, __v, $meta, ...rawmsg } = msg || {}
    return rawmsg
  }

  // set current actor as owner of given message
  own (msg) {

    //do nothing
    return
  }

  // returns true if current actor is registered as owner of given msg
  owns (msg) {

    //! check owner & admin against each actor.actors
    return Acl.isMember(msg, 'owner', this.actor) || Acl.isMember(msg, 'admins', this.actor)
  }
}

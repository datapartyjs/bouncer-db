'use strict'

const Crufler = require('./crufler.js')
const debug = require('debug')('bouncer-db.admin-crufler')

/** admin-crufler extends crufler to give caller administrator permissions */
module.exports = class AdminCrufler extends Crufler {

  constructor ({ type, collection }) {
    super({ type, collection })

    debug(`new crufler: ${JSON.stringify(this)}`)
  }

  filterQuerySpec (spec) {
    debug(`filtered query spec -> ${JSON.stringify(spec)}`)
    return spec
  }

  async canRead (msg) {
    return true
  }

  async canNew (msg) {
    return true
  }

  async canChange (msg, newMsg) {
    return true
  }

  redactWrite (msg) {
    const { _id, __v, $meta, ...rawmsg } = msg || {}
    return rawmsg
  }

  own (msg) {

    //do nothing
    return
  }

  owns (msg) {

    return true
  }
}

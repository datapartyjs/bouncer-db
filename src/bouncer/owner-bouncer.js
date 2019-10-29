'use strict'

const Bouncer = require('./bouncer.js')
const OwnerCrufler = require('./owner-crufler.js')

const debug = require('debug')('bouncer-db.owner-bouncer')

module.exports = class OwnerBouncer extends Bouncer {

  isOnListFor (type) {
    return type in this.collections // TODO -> whitelist types
  }

  async getCruflerFor (type) {

    let permissions = { read: true, new: true, change: true }
    
    if(this.collections[type].permissions){
      debug('loading custom permissions')
      permissions = await this.collections[type].permissions(this.context)
    }

    return this.isOnListFor(type)
      ? new OwnerCrufler({
        actor: this.actor,
        permissions:  permissions,
        type: type,
        collection: this.collections[type],
        collections: this.collections
      })
      : null
  }
}

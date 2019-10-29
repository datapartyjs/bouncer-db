'use strict'

const Bouncer = require('./bouncer.js')
const AdminCrufler = require('./admin-crufler.js')

const debug = require('debug')('bouncer-db.admin-bouncer')

module.exports = class AdminBouncer extends Bouncer {

  isOnListFor (type) {
    return type in this.collections // TODO -> whitelist types
  }

  async getCruflerFor (type) {

    return this.isOnListFor(type)
      ? new AdminCrufler({
        type: type,
        collection: this.collections[type]
      })
      : null
  }
}

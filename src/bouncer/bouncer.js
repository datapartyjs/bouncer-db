'use strict'

const debug = require('debug')('bouncer-db.bouncer')

module.exports = class Bouncer {

  constructor ({ actor, collections, context }) {
    this.actor = actor
    this.collections = collections
    this.context = context

    debug(`new bouncer: ${JSON.stringify(this)}`)
  }

  isOnListFor (type) {
    return false
  }

  async getCruflerFor (type) {
    return null
  }

  // unwrap crufl bundle & freshen crufls in parallel
  // * return freshpak of fresh msgs with state changed by crufl bundle ops
  // * accepts censor to filter access to message collection
  async freshen (bundle) {
    const promisedFreshness = []
    for (const crufl of bundle.crufls) {
      if (this.isOnListFor(crufl.type)) {
        const crufler = await this.getCruflerFor(crufl.type)
        promisedFreshness.push(crufler.freshen(crufl)) // collect promises
      } else {
        debug(`not on list for collection type '${crufl.type}'`)
      }
    }

    // filter out any crufls that fail to freshen before returning freshpak
    return {
      uuid: bundle.uuid,
      freshness: (await Promise.all(promisedFreshness)) // parallel resolve
        .filter(fresh => fresh !== null),
      complete: true
    }
  }
}

const mongoose = require('mongoose')
mongoose.Promise = Promise
require('mongoose-schema-jsonschema')(mongoose)
mongoose.plugin(require("mongoose-ajv-plugin"))
const BouncerModel = require('@dataparty/bouncer-model')

const Bouncer = require('./bouncer')
const AdminBouncer = require('./bouncer/admin-bouncer')
const debug = require('debug')('bouncer.db')

if(debug.enabled){ mongoose.set('debug', true) }


class Db {
  constructor (uri, options) {
    this.uri = uri
    this.options = options || {}
    Object.assign(this.options, {
      keepAlive: 200,
      useCreateIndex: true,
      useNewUrlParser: true,
      autoReconnect: true,
      reconnectTries: Number.MAX_VALUE,
      reconnectInterval: 1000
    })

    this.model = {}
  }

  get types(){
    return this.model
  }

  addBouncerModels(model){
    for(let schema of model.JSONSchema){
      debug('addBouncerModels', schema.title)

      const generic = BouncerModel.Model.generate({
        JSONSchema: schema,
        Permissions: model.Permissions[schema.title],
        IndexSettings: model.IndexSettings[schema.title]
      })

      this.addModel(generic)
    }
  }

  addModels({Types}){
    for(const type in Types){
      const Class = Types[type]
      this.addModel(Class)
    }
  }

  addModel(Class){
    const name = Class.Type

    if(!this.model[name]){ debug('addModel -', name) }
    else{ debug('addModel - replace -', name) }

    let {model} = Class.install(Db.mongoose())
    this.model[name] = model
  }

  /* Please note: we are only able to pass connection options
     through the uri on cloud functions.
  */
  connect(){
    return mongoose.connect(this.uri, this.options)
  }

  close(){
    return mongoose.disconnect()
  }

  ask ({ actor, bundle, context }) {

    debug(`running ask against collections: ${Object.keys(this.types)}`)

    const bouncer = new Bouncer({ actor, collections: this.types, context })
    return bouncer.freshen(bundle)
  }

  adminAsk ({ bundle, context }) {
    debug(`running ask against collections: ${Object.keys(this.types)}`)

    const bouncer = new AdminBouncer({ collections: this.types })
    return bouncer.freshen(bundle)
  }

  static mongoose(){
    return mongoose
  }
}

module.exports = Db

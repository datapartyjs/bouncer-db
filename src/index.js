const Db = require('./db')
const BouncerModel = require('@dataparty/bouncer-model')
const Models = BouncerModel.Types

/*class B extends Model {
  constructor(){
    super()
  }

  static get Schema(){
    return { name: String }
  }

  static get Type(){ return 'b' }
}


console.log(B.install())*/


async function main(){

  console.log('main')

  let db = new Db('mongodb://localhost:27017/bouncer-local-test')

  db.addModels(BouncerModel)

  /*db.addModel(Models.Acl)
  db.addModel(Models.Org)
  db.addModel(Models.User)
  db.addModel(Models.Team)
  db.addModel(Models.Device)
  db.addModel(Models.Identity)*/


  console.log('connecting')
  await db.connect()
  console.log('connected')
}


// Run main
main().catch((error) => {
  console.error(error.message)
  console.error(error)
  process.exit()
})


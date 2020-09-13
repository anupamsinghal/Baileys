import {
    WAConnection,
    MessageType,
    Presence,
    MessageOptions,
    Mimetype,
    WALocationMessage,
    MessageLogLevel,
    WA_MESSAGE_STUB_TYPES,
    ReconnectMode,
} from '../src/WAConnection/WAConnection'
import * as fs from 'fs'

const mysql = require('mysql');
const config = require('../config.json')
let sqlConnection
const waConnection = new WAConnection() 

const g_simulation: boolean = config.simulation
const g_sleepMs : number = config.sleepMs

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectToDb() {
    sqlConnection = mysql.createConnection({
        host     : config.host,
        user     : config.user,
        password : config.password,
        database : config.database
    });
    sqlConnection.connect(function(err) {
        if (err) {
            console.error('error connecting: ' + err.stack);
            return;
        }
        console.log('connected as id ' + sqlConnection.threadId);
    });
    await connectToWhatsApp().catch (err => console.log("unexpected error: " + err) ) // catch any errors
}

function cleanup() {
    console.log('In cleanup')
    sqlConnection.end(function(error) {
        if (error)
            console.log('FATAL ERROR closing mysql connection')
    });
}


function e4_saveExists(phone, exists) {
    //console.log('in saveExists: ', phone)
    let query

    if (exists) {
        query = 'update users set exists_on_wa = 1, exists_on_wa_check_time = now() where cell_num = ?'
    } else {
        query = 'update users set exists_on_wa = 0, exists_on_wa_check_time = now() where cell_num = ?'
    }

    //console.log('query: ', query)
    sqlConnection.query(query, [phone], function(error, results, fields) {
        if (error) throw error;
        console.log('changed ' + results.changedRows + ' rows');
    });    
}

function convertPhoneToWAUserId(phone) {
    let newPhone = phone.replace('(', '').replace(')', '').replace(/\ /g, '').replace(/\-/g, '').replace(/\./g, '')
    newPhone = '1' + newPhone
    if (newPhone.length != 11) {
        console.log('ERROR: bad phone: ', newPhone)
        return
    }
    return newPhone + '@s.whatsapp.net'
 }

async function e3_validatePhone(phone) {
    //console.log('In validatePhone: ', phone)
    const newid = convertPhoneToWAUserId(phone)

    //console.log('checking for: ', newid)
    const exists = await waConnection.isOnWhatsApp (newid)
    console.log (`${newid} ${exists ? " exists " : " does not exist"} on WhatsApp`)

    // save result back in db
    e4_saveExists(phone, exists)
}


// query db and get one phone number 
function e2_processExists() {
    // console.log('In processExists')

    const query = 'select cell_num as num from users where exists_on_wa is null limit 1'
    sqlConnection.query(query, function (error, results, fields) {
        if (error) throw error;
        //console.log('Returning number: ', results[0].num);
        if (results.length > 0)
            e3_validatePhone(results[0].num)
        else {
            console.log('ERROR: no rows found')
        }
    });
}

async function e1_determineMaxAndLoop() {
    const query = 'select count(distinct(cell_num)) as num from users where exists_on_wa is null'

    sqlConnection.query(query, async function(error, results, fields) {
        if (error) throw error;
        //console.log('Returning number: ', results[0].num);
        if (results.length > 0 && results[0].num > 0) {
            const numToProcess = results[0].num
            console.log('*** Processing rows = ', numToProcess)

            for (let i = 0; i < numToProcess; i++) {
                console.log('***', i + 1, ' of ', numToProcess)
                e2_processExists()
                await sleep(1000)
            }
            cleanup()
        } else {
            console.log('ERROR: no rows found.')
            cleanup()
        }
    });
}

async function connectToWhatsApp() {
    
    //console.log('1')
    waConnection.autoReconnect = ReconnectMode.onConnectionLost // only automatically reconnect when the connection breaks
    waConnection.logLevel = MessageLogLevel.info // set to unhandled to see what kind of stuff you can implement

    // loads the auth file credentials if present
    fs.existsSync('./auth_info.json') && waConnection.loadAuthInfo ('./auth_info.json')
    
    /* Called when contacts are received, 
     * do note, that this method may be called before the connection is done completely because WA is funny sometimes 
     * */
    //waConnection.on ('contacts-received', contacts => console.log(`received ${Object.keys(contacts).length} contacts`))
    
    // connect or timeout in 60 seconds
    await waConnection.connect()

    const authInfo = waConnection.base64EncodedAuthInfo() // get all the auth info we need to restore this session
    fs.writeFileSync('./auth_info.json', JSON.stringify(authInfo, null, '\t')) // save this info to a file

    console.log()
    if (g_simulation) {
        console.log("*** Running in SIMULATION mode")
    } else {
        console.log("*** Running for REAL")
    }
    await sleep(g_sleepMs)

    console.log ("oh hello " + waConnection.user.name + " (" + waConnection.user.jid + ")")
    console.log ("you have " + waConnection.chats.all().length + " chats")
    console.log()

    // 1 exists flow: determine max and loop
    await e1_determineMaxAndLoop()
}

// run in main file
connectToDb() //.catch (err => console.log("unexpected error: " + err) ) // catch any errors

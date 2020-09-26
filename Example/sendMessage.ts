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
    GroupSettingChange,
} from '../src/WAConnection/WAConnection'
import * as fs from 'fs'

const mysql = require('mysql');
const config = require('../config.json')

let g_sqlConnection
const g_waConnection = new WAConnection() 

// message send
// settings moved to config.json

// in simulation, use is_test users, ignore g_processMax
const g_simulation: boolean = config.simulation

const g_createGroup: boolean = config.createGroup

const g_message: string = config.message
const g_adminIds: number[] = config.adminIds
const g_adminPhones: string[] = config.adminPhones   // TODO, remove this, read from db

const g_simUserIds: number[] = config.simUserIds
const g_simUserPhones: string[] = config.simUserPhones

const g_groupName: string = config.groupName
const g_cohortId: number = config.cohortId
const g_processMax: number = config.processMax
const g_sleepMs : number = config.sleepMs

// 9999 is for test
const g_group250Num: number = config.group250Num
const g_singleUserGroup: boolean = config.singleUserGroup
const g_sendMessage: boolean = config.sendMessage

// if createGroup is false, this gets used
let g_groupId: number = config.groupId
let g_waGroupId: string = config.waGroupId

let g_messageId: number
let g_me: string
let g_users: string[] = []

async function cleanupSendMessage() {
    console.log('FATAL: in cleanupSendMessage')
    await rollback()
    process.exit()
}

// in one shot, unlike the painful approach earlier
async function addToGroup() {
    // id & people to add to the group (will throw error if it fails)
    try {

        console.log('in addToGroup, adding users: ', g_users)
        const response = await g_waConnection.groupAdd(g_waGroupId, g_users)

    } catch (err) {        
        console.log("FATAL in addToGroup: ", err)
        cleanupSendMessage()
        throw err
    }
 }


async function createGroup() { //userId, cellNum) {    
    if (!g_createGroup) { 
        return
    }

    try {
        console.log("creating group")
        let admins = g_adminPhones
        admins = admins.map(admin => convertPhoneToWAUserId(admin))
        let group = await g_waConnection.groupCreate(g_groupName, admins)
        console.log("created group")
        g_waGroupId = group.gid

        await g_waConnection.groupMakeAdmin(g_waGroupId, admins)
        // TODO: add to config
        // only allow admins to send messages
        await g_waConnection.groupSettingChange(g_waGroupId, GroupSettingChange.messageSend, true)
        // only allow admins to modify the group's settings
        await g_waConnection.groupSettingChange(g_waGroupId, GroupSettingChange.settingsChange, true)

        const query = "insert ignore into `groups` (name, wa_id) values (?, ?)"
        g_sqlConnection.query(query, [g_groupName, g_waGroupId], function(error, results, fields) {
            if (error) {
                cleanupSendMessage()
                throw error;
            }
            //console.log('affected ' + results.affectedRows + ' rows');
            g_groupId = results.insertId
            // sm4_addUserGroups(userId, group.gid, )
        });
    } catch (err) {        
        console.log("FATAL in createGroup: ", err)
        cleanupSendMessage()
        throw err
    }
}

async function sendMessage() {
    if (!g_sendMessage) {
        return
    }

    try {

        console.log('sending message')
        await g_waConnection.sendMessage(g_waGroupId, g_message, MessageType.text)
        console.log('message sent')

    } catch (err) {        
        console.log("FATAL in sendMessage: ", err)
        cleanupSendMessage()
        throw err
    }    
}

function prepAddToGroup(counter: number) {
    // 1 add message to messages table, if not already there
    // 2 pick user not in cohort already
    // 3 add to user_cohort
    // 4 add user to user_group table
    // 5 add to user_message table

    const query = `insert ignore into messages (content, cohort_id) values ("${g_message}", ${g_cohortId})`
    g_sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        g_messageId = results.insertId
        sm2_pickUser(counter)
    });    
}

function sm2_pickUser(counter: number) {
    //console.log("in pickUser: ")
    let query
    if (g_simulation) {
        if (g_singleUserGroup) {
            query = `select id, cell_num from users where is_test = 1 limit 1`
        } else {
            query = `select id, cell_num from users where is_test = 1 limit 1`
            // query = `select id, cell_num from users where group_num = ${g_group250Num} AND exists_on_wa = 1 limit 1`
        }
    } else {
        if (g_singleUserGroup) {
            query = `select id, cell_num from users where cohort_id = ${g_cohortId} AND is_admin = 0 AND optout_time is null AND exists_on_wa = 1 AND id not in (select user_id from user_cohort where cohort_id = ${g_cohortId}) limit 1`
        } else {
            query = `select id, cell_num from users where cohort_id = ${g_cohortId} AND group_num = ${g_group250Num} AND is_admin = 0 AND optout_time is null AND exists_on_wa = 1 AND id not in (select user_id from user_cohort where cohort_id = ${g_cohortId}) limit 1`
        }
    }
    g_sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        if (g_simulation) {
            console.log(`picked user with id = ${g_simUserIds[counter]} and phone = ${g_simUserPhones[counter]}`)
            g_users.push(convertPhoneToWAUserId(g_simUserPhones[counter]))
            sm3_userCohort(g_simUserIds[counter])
        } else if (results.length > 0) {
            console.log(`picked user with id = ${results[0].id} and phone = ${results[0].cell_num}`)
            g_users.push(convertPhoneToWAUserId(results[0].cell_num))
            sm3_userCohort(results[0].id)
        } else {
            console.log('ERROR in pickUser: no rows found')
            cleanupSendMessage()
        }
    });
}

function sm3_userCohort(userId: number) {
    const query = `insert ignore into user_cohort (user_id, cohort_id) values (${userId}, ${g_cohortId})`
    g_sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        console.log('user_cohort affected ' + results.affectedRows + ' rows');
        sm4_addUserGroups(userId)
    });
}


function sm4_addUserGroups(userId: number) {
    //console.log('in sm4_addUserGroups: ', waGroupId, groupId)

    let query = `insert ignore into user_group (user_id, group_id) values (${userId}, ${g_groupId})`
    //g_adminIds.forEach(adminId => query += `, (${adminId}, ${g_groupId})`)
    //console.log(query)
    g_sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        console.log('user_group affected ' + results.affectedRows + ' rows');
        sm5_addUserMessages(userId)
    });
}

// for simulation, this won't update cos unique key is (user_id, message_id)
function sm5_addUserMessages(userId) {
    //console.log('in addUserMessage', userId, messageId)
    let query
    if (g_messageId == 0) {
        query = `insert ignore into user_message (sent_time, user_id, group_id, message_id) values (now(), ${userId}, ${g_groupId}, (select id from messages where content = "${g_message}" and cohort_id = ${g_cohortId})) on duplicate key update sent_time = now()`
    } else {
        query = `insert ignore into user_message (sent_time, user_id, message_id, group_id) values (now(), ${userId}, ${g_messageId}, ${g_groupId}) on duplicate key update sent_time = now()`
    }
    //console.log(query)
    g_sqlConnection.query(query, async function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        console.log('user_message affected ' + results.affectedRows + ' rows');
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function beginTransaction() {
    g_sqlConnection.beginTransaction(function(err) {
        if (err) { throw err; }
        console.log("BEGIN transacation.")
    })
    await sleep(500)
}

async function rollback() {
    g_sqlConnection.rollback(function(err) {
        if (err) { throw err; }
        console.log("ROLLING back transacation.")
    })
    await sleep(1000)
}

async function commit() {
    g_sqlConnection.commit(function(err) {
        if (err) { throw err; }
        console.log("COMMITTING transacation.")
    })
    await sleep(2000)
}

async function connectToDb() {
    g_sqlConnection = mysql.createConnection({
        host     : config.host,
        user     : config.user,
        password : config.password,
        database : config.database
    });
    g_sqlConnection.connect(function(err) {
        if (err) {
            console.error('error connecting: ' + err.stack);
            return;
        }
        //console.log('connected as id ' + g_sqlConnection.threadId);
    });
    await connectToWhatsApp().catch (err => console.log("unexpected error: " + err) ) // catch any errors
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

function updateMessageStatus(message) {
    // handle case where FROM is not from a group AND TO is to a group
    const from = message.from + ''
    const to = message.to + ''
    let user = message.participant + ''
    user = user.replace('@c.us', '').substr(1)
    //console.log('*** from user: ', user)
    if (from.includes('@c') && to.includes('@g')) {
        //console.log('in updateMessageStatus')
        const waGroupId = to
        let field: string
        if (message.type == 3) {
            field = 'deliver_time'
        } else if (message.type == 4) {
            field = 'read_time'
        } else {
            return
        }

        let query: string
        if (g_messageId == 0) {
            query = `update user_message set ${field} = now() where message_id in (select id from messages where content = "${g_message}" and cohort_id = ${g_cohortId}) AND user_id in (select id from users where normalized_cell = "${user}")`
        } else {
            query = `update user_message set ${field} = now() where message_id = ${g_messageId} AND user_id in (select id from users where normalized_cell = "${user}")`
        }    
        //console.log(query)
        g_sqlConnection.query(query, function(error, results, fields) {
            if (error) {
                cleanupSendMessage()
                throw error;
            }
            if (results.affectedRows > 0) {
                console.log('affected ' + results.affectedRows + ' rows. ', message.type);
            }
        });        
    }
}

function optoutUser(user) {
    user = user.replace('@s.whatsapp.net', '').substr(1)
    console.log("opting out: ", user)
    const query = `update users set optout_time = now() where normalized_cell = "${user}"`
    g_sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        console.log('affected ' + results.affectedRows + ' rows');
    });
}

function listen() {
    g_waConnection.on('message-status-update', (message) => {
        //console.log ('from: ', message.from)
        //console.log ('to: ', message.to, message.ids)
        //console.log ('type: ', message.type, message.participant)
        updateMessageStatus(message)
    })

    // no way to differentiate between user exiting themselves and admin removing them
    // we will assume user quit
    // TODO: user STOP same as opt out
    g_waConnection.on ('group-participants-remove', (update) => {
        console.log ('jid: ', update.jid)
        console.log ('participants: ', update.participants)

        // mark participate as opt-out
        if (update.participants.length > 0) {
            optoutUser(update.participants[0])
        }
        // : {jid: string, participants: string[], actor?: string}
    })
}

async function connectToWhatsApp() {
    
    //console.log('1')
    g_waConnection.autoReconnect = ReconnectMode.onConnectionLost // only automatically reconnect when the connection breaks
    g_waConnection.logLevel = MessageLogLevel.info // set to unhandled to see what kind of stuff you can implement

    // loads the auth file credentials if present
    fs.existsSync('./auth_info.json') && g_waConnection.loadAuthInfo ('./auth_info.json')
    
    /* Called when contacts are received, 
     * do note, that this method may be called before the connection is done completely because WA is funny sometimes 
     * */
    //waConnection.on ('contacts-received', contacts => console.log(`received ${Object.keys(contacts).length} contacts`))
    
    // connect or timeout in 60 seconds
    await g_waConnection.connect()

    const authInfo = g_waConnection.base64EncodedAuthInfo() // get all the auth info we need to restore this session
    fs.writeFileSync('./auth_info.json', JSON.stringify(authInfo, null, '\t')) // save this info to a file

    console.log()
    if (g_simulation) {
        console.log("*** Running in SIMULATION mode with loop value: ", g_processMax)        
    } else {
        console.log("*** Running for REAL with loop value: ", g_processMax)
    }
    await sleep(3000)

    g_me = g_waConnection.user.jid
    console.log ("oh hello " + g_waConnection.user.name + " (" +  g_me + ")")
    console.log ("you have " + g_waConnection.chats.all().length + " chats")
    console.log()

    // message send flow

    beginTransaction()
    
    // create or reuse group
    createGroup()

    // pick users
    let users: string[] = []
    for (let i = 0; i < g_processMax; i++) {
        console.log('***', i+1, ' of ', g_processMax)
        prepAddToGroup(i)
        await sleep(g_sleepMs)
    }
    // add to group and send message
    await addToGroup()
    await sendMessage()
    commit()
}


listen()
// run in main file
connectToDb() //.catch (err => console.log("unexpected error: " + err) ) // catch any errors


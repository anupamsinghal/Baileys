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

// message send
// settings moved to config.json

const g_simulation: boolean = config.simulation
const g_message: string = config.message
const g_adminIds = config.adminIds
const g_adminPhones = config.adminPhones   // TODO, remove this, read from db
const g_groupName: string = config.groupName
const g_cohortId: number = config.cohortId
const g_processMax: number = config.processMax
const g_sleepMs : number = config.sleepMs

// 9999 is for test
const g_group250Num: number = config.group250Num
const g_singleUserGroup: boolean = config.singleUserGroup
const g_sendMessage: boolean = config.sendMessage

// limit on how many groups can be created on single phone
// switched to Josh3
const g_groupId: number = config.groupId
const g_waGroupId: string = config.waGroupId

let g_messageId: number

function cleanupSendMessage() {
    console.log('FATAL: in cleanupSendMessage')
    process.exit()
}

async function sendMessage() {
    // if singleUserGroup = false, then we're NOT creating a new group. We're adding multiples to same group
    // g_group250Num

    // 1 add message to messages table, if not already there
    // 2 pick user not in cohort already, add to user_cohort
    // 3 create WA group and add to grps table
    // 4 add user to user_group table
    // 5 add to user_message table
    // 6 send message
    // 7 update user_message

    // handle the fact that phone numbers are not unique: made users.cell_num unique
    // TODO: run for 2 users

    const query = `insert ignore into messages (content, cohort_id) values ("${g_message}", ${g_cohortId})`
    sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        g_messageId = results.insertId
        sm2_pickUser()
    });    
}

function sm2_pickUser() {
    //console.log("in pickUser: ")
    let query
    if (g_simulation) {
        if (g_singleUserGroup) {
            query = `select id, cell_num from users where is_test = 1 limit 1`
        } else {
            query = `select id, cell_num from users where group_num = ${g_group250Num} AND exists_on_wa = 1 limit 1`
        }
    } else {
        if (g_singleUserGroup) {
            query = `select id, cell_num from users where cohort_id = ${g_cohortId} AND is_admin = 0 AND optout_time is null AND exists_on_wa = 1 AND id not in (select user_id from user_cohort where cohort_id = ${g_cohortId}) limit 1`
        } else {
            query = `select id, cell_num from users where cohort_id = ${g_cohortId} AND group_num = ${g_group250Num} AND is_admin = 0 AND optout_time is null AND exists_on_wa = 1 AND id not in (select user_id from user_cohort where cohort_id = ${g_cohortId}) limit 1`
        }
    }
    sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        if (results.length > 0) {
            console.log(`picked user with id = ${results[0].id} and phone = ${results[0].cell_num}`)
            sm22_userCohort(results[0].id, results[0].cell_num)
        } else {
            console.log('ERROR in pickUser: no rows found')
            cleanupSendMessage()
        }
    });
}

function sm22_userCohort(userId, cellNum) {
    const query = `insert ignore into user_cohort (user_id, cohort_id) values (${userId}, ${g_cohortId})`
    sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        sm3_createGroup(userId, cellNum)
    });
}

async function sm3_createGroup(userId, cellNum) {
    //console.log('in createGroup: ', messageId, userId, cellNum)

    //console.log('creating group with users: ', users)
    
    // instead of creating a new one, first see if one already exists with the desired group name and users
    let group

    //console.log('creating WA group')

    let users = [cellNum]

    if (!g_singleUserGroup) {
        // reuse existing group
        // add user to group
        users = users.map(user => convertPhoneToWAUserId(user))

        try {
            //console.log("adding user to group")
            const response = await waConnection.groupAdd(g_waGroupId, users)
        } catch (err) {
            console.log("FATAL: ", err)
            process.exit()    
        }
        sm4_addUserGroups(userId, g_waGroupId, g_groupId)
        return
    }

    if (g_simulation) {
        sm4_addUserGroups(userId, g_waGroupId, g_groupId)
        return
    }

    // add the 3 users, 1 + 2 admins
    users = users.concat(g_adminPhones)
    users = users.map(user => convertPhoneToWAUserId(user))
    
    try {
        group = await waConnection.groupCreate(g_groupName, users)
    } catch (err) {        
        console.log("FATAL: ", err)
        process.exit()
    }
    //console.log('created WA group')
    const query = "insert ignore into `groups` (name, wa_id) values (?, ?)"
    sqlConnection.query(query, [g_groupName, group.gid], function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        sm4_addUserGroups(userId, group.gid, results.insertId)
    });
}

function sm4_addUserGroups(userId, waGroupId, groupId) {
    //console.log('in sm4_addUserGroups: ', waGroupId, groupId)

    let query = `insert ignore into user_group (user_id, group_id) values (${userId}, ${groupId})`
    g_adminIds.forEach(adminId => query += `, (${adminId}, ${groupId})`)
    //console.log(query)
    sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        sm5_addUserMessages(userId, waGroupId, groupId)
    });
}

// for simulation, this won't update cos unique key is (user_id, message_id)
function sm5_addUserMessages(userId, waGroupId, groupId) {
    //console.log('in addUserMessage', userId, messageId)
    let query
    if (g_messageId == 0) {
        query = `insert ignore into user_message (sent_time, user_id, group_id, message_id) values (now(), ${userId}, ${groupId}, (select id from messages where content = "${g_message}" and cohort_id = ${g_cohortId})) on duplicate key update sent_time = now()`
    } else {
        query = `insert ignore into user_message (sent_time, user_id, message_id, group_id) values (now(), ${userId}, ${g_messageId}, ${groupId}) on duplicate key update sent_time = now()`
    }
    //console.log(query)
    sqlConnection.query(query, async function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        if (g_sendMessage) {
            await waConnection.sendMessage(waGroupId, g_message, MessageType.text)
            console.log('message sent')
        }
    });
}

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

function convertPhoneToWAUserId(phone) {
    let newPhone = phone.replace('(', '').replace(')', '').replace(' ', '').replace('-', '')
    newPhone = '1' + newPhone
    if (newPhone.length != 11) {
        console.log('ERROR: bad phone: ', newPhone)
        return
    }
    return newPhone + '@s.whatsapp.net'
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
        console.log("*** Running in SIMULATION mode with loop value: ", g_processMax)        
    } else {
        console.log("*** Running for REAL with loop value: ", g_processMax)
    }
    await sleep(2000)

    console.log ("oh hello " + waConnection.user.name + " (" + waConnection.user.jid + ")")
    console.log ("you have " + waConnection.chats.all().length + " chats")
    console.log()

    // message send flow
    for (let i = 0; i < g_processMax; i++) {
        console.log('***', i+1, ' of ', g_processMax)
        await sendMessage()
        await sleep(g_sleepMs)
    }

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
        sqlConnection.query(query, function(error, results, fields) {
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
    sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        console.log('affected ' + results.affectedRows + ' rows');
    });
}

function listen() {
    waConnection.on('message-status-update', (message) => {
        //console.log ('from: ', message.from)
        //console.log ('to: ', message.to, message.ids)
        //console.log ('type: ', message.type, message.participant)
        updateMessageStatus(message)
    })

    // no way to differentiate between user exiting themselves and admin removing them
    // we will assume user quit
    // TODO: user STOP same as opt out
    waConnection.on ('group-participants-remove', (update) => {
        console.log ('jid: ', update.jid)
        console.log ('participants: ', update.participants)

        // mark participate as opt-out
        if (update.participants.length > 0) {
            optoutUser(update.participants[0])
        }
        // : {jid: string, participants: string[], actor?: string}
    })
}

listen()
// run in main file
connectToDb() //.catch (err => console.log("unexpected error: " + err) ) // catch any errors

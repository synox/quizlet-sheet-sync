#!/usr/local/bin/node

const {google} = require('googleapis');
const googleAuth = require('google-auth-library');
const wanakana = require('wanakana');
const request = require('request');
const fs = require('fs');

var OAuth2 = google.auth.OAuth2;

const sheet_id = process.argv[2];
if (!sheet_id) {
    console.log('Please provide a sheet_id:');
    console.log('  node index.js SHEET_ID');
    process.exit(1);
}


if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET || !process.env.ACCESS_TOKEN) {
    console.log('Please provide ENV variables CLIENT_ID, CLIENT_SECRET and ACCESS_TOKEN');
    process.exit(1);
}

// Bearer token for Quizlet
const access_token = process.env.ACCESS_TOKEN;

// Authorize google client library
const tokens = JSON.parse(fs.readFileSync('credentials.json'));
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
var authClient = new OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
);
authClient.credentials = tokens;

google.options({auth: authClient});
const sheets = google.sheets('v4');
const drive = google.drive('v3');

// Can set this to 'only_me' to make sets private.
const visibility = 'public';

// Get or create a file for the requested spreadsheet, stored in Google Drive
// in your `appDataFolder`, to map sheet tab IDs to Quizlet set IDs.
function getOrCreateMetadata() {
    return new Promise(function (resolve, reject) {
        console.log('looking...');
        drive.files.list({
            spaces: 'appDataFolder',
            q: `name = "${sheet_id}"`,
            pageSize: 100
        }, function (err, response) {
            if (err) return reject(err);
            if (response.data.files && response.data.files.length > 0) {
                console.log('found existing metadata file');
                drive.files.get({
                    fileId: response.data.files[0].id,
                    alt: 'media'
                }, function (err, response) {
                    if (err) return reject(err);
                    console.log('retrieved metadata contents');
                    resolve(response.data);
                })

            } else {
                console.log('creating metadata file...');
                drive.files.create({
                    resource: {
                        name: sheet_id,
                        parents: ['appDataFolder']
                    },
                    media: {
                        mimeType: 'application/json',
                        body: '{}'
                    }
                }, function (err, file) {
                    if (err) return reject(err);
                    console.log('created metadata file');
                    resolve({});
                });
            }
        })
    });
}

// Update metadata in Google Drive's appDataFolder
async function updateSheetMetadata(metadata, sheet_id) {
    // Search for the file again by name to get the fileId
    // (so we don't have to save it)
    let response = await drive.files.list({
        spaces: 'appDataFolder',
        q: `name = "${sheet_id}"`,
        pageSize: 100
    });
    console.log('saving metadata...');

    let files = response.data.files;
    if (files.length > 0) {
        await drive.files.update({
            fileId: files[0].id,
            media: {
                mimeType: 'application/json',
                body: JSON.stringify(metadata)
            }
        });
        console.log('metadata saved');
    }

    return await Promise.resolve({});
}

// Lookup a set id by tab id in the sheet metadata.
// If one isn't found, then create a new set.
function getOrCreateSetId(metadata, set_name) {
    return new Promise(function (resolve, reject) {
        if (metadata[set_name]) {
            console.log(`Found existing set id for tab ${set_name}`);
            return resolve(metadata[set_name]);

        } else {
            // create the set first

            console.log("Creating new set...");
            request.post({
                url: `https://api.quizlet.com/2.0/sets`,
                headers: {
                    Authorization: `Bearer ${access_token}`,
                    'Content-Type': 'application/javascript'
                },
                form: {
                    title: `tab id ${set_name}`,
                    visibility: visibility,
                    whitespace: 1,
                    lang_terms: 'ja',
                    lang_definitions: 'en',
                    definitions: ['', ''],
                    terms: ['', ''],
                }
            }, function (err, response, body) {
                if (err) return reject(err);
                let set_id = JSON.parse(body).set_id;
                metadata[set_name] = set_id;
                console.log(`Created set ${set_id} for tab ${set_name}`);
                return resolve(set_id);
            });
        }
    });
}

// Update a Quizlet set with the given data. If it fails, create the set.
async function updateSet(metadata, set_name, data) {
    let set_id = await getOrCreateSetId(metadata, set_name);
    let set_data = {
        whitespace: 1,
        lang_definitions: 'en',
    };
    Object.assign(set_data, data);
    console.log(`Updating set ${set_id}: ${set_name}`);

    let httpResponse = await request.put({
        url: `https://api.quizlet.com/2.0/sets/${set_id}`,
        headers: {
            Authorization: `Bearer ${access_token}`
        },
        form: set_data
    });

    if (httpResponse.http_code === 404 || httpResponse.http_code === 410) {
        // Set not found. Cached set ID may have been deleted.
        // Clear metadata cache for tab, and try creating one more time.
        console.log('set not found');
        metadata[set_name] = null;
        let set_id = await getOrCreateSetId(metadata, set_name);

        await request.put({
            url: `https://api.quizlet.com/2.0/sets/${set_id}`,
            headers: {
                Authorization: `Bearer ${access_token}`
            },
            form: set_data
        });
    } else {
        console.log(`Updated set ${set_id}`);
    }
    return Promise.resolve();
}


async function copySheetToQuizlet(sheet, metadata) {
    let tab_id = sheet.properties.sheetId;
    let tab_name = sheet.properties.title;


    let tableDataResponse = await loadTableData(sheet_id, tab_id, tab_name);
    let rows = tableDataResponse.data.values;

    let data = []; // TODO: .map
    for (const row of rows) {
        let romaji = row[0];
        let definition = row[1];
        let kana = wanakana.toKana(romaji);
        data.push({
            romaji: romaji.toLowerCase(),
            definition: definition,
            kana: kana
        });
    }

    terms = data.map(i => i.romaji);
    terms_kana = data.map(i => i.kana);
    definitions = data.map(i => i.definition);


    let updateSet1 = updateSet(metadata, tab_id, {
        title: tab_name,
        lang_terms: 'ja-ro',
        definitions: definitions,
        terms: terms,
    });
    let updateSet2 = updateSet(metadata, tab_id + ':kana', {
        title: tab_name + ' (Kana)',
        lang_terms: 'ja',
        definitions: definitions,
        terms: terms_kana,
    });
    return await Promise.all([updateSet1, updateSet2]);
}


function loadTableData(sheet_id, tab_id, tab_name) {
    console.log('fetching', `${tab_name}!A:B`);
    return sheets.spreadsheets.values.get({spreadsheetId: sheet_id, range: `${tab_name}!A:B`});
}

async function main() {
    // Run the script
    // 1. Get set metadata
    // 2. Look up sheets
    // 3. Loop over each sheet and fetch columns A and B
    // 4. Run through Wanakana to get romaji and kana versions of terms
    // 5. Update or create two Quizlet sets for each tab
    // 6. Save set metadata
    try {
        let metadata = await getOrCreateMetadata();
        let response = await sheets.spreadsheets.get({spreadsheetId: sheet_id});
        let sheetsList = response.data.sheets;
        await Promise.all(sheetsList.map(sheet => copySheetToQuizlet(sheet, metadata)));
        await updateSheetMetadata(metadata, sheet_id);
    } catch
        (reason) {
        console.log('error', reason);
        process.exit(1);
    }
}

main();

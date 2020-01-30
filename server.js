// Config variables
var CLIENT_ID = ""
var CLIENT_SECRET = ""
var PORT = 8080;
var REDIRECT_URI = "http://localhost:8080/discord/callback";

// Node module imports
var express = require('express');
var session = require('express-session');
var sqlitestore = require('connect-sqlite3')(session);
var request = require('request-promise');
var ipn = require('express-ipn');
var bodyParser = require('body-parser');
var sqlite3 = require('better-sqlite3');
var uuid = require('uuid/v4');

// Node module instantiation
var app = express();
var db = new sqlite3('donations.db', { verbose: console.log });

// Initialise the database if it's empty
// Get a list of tables in the database
var tables = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all();
console.log(JSON.stringify(tables));
// Make sure the donor and donation tables exist
if (!tables.find(table => table.name == 'donor')) {
    db.prepare('CREATE TABLE donor (id INTEGER, name TEXT NOT NULL, avatar TEXT NOT NULL, PRIMARY KEY (id))').run();
}
if (!tables.find(table => table.name == 'donation')) {
    db.prepare('CREATE TABLE donation (id TEXT NOT NULL, donorId INTEGER, amount REAL NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY (id), FOREIGN KEY (donorId) REFERENCES donor (id))').run();
}
// Make sure the anonymous donor exists
var anonymousDonorId = db.prepare('SELECT id FROM donor WHERE id = 0').get();
if (!anonymousDonorId) {
    db.prepare('INSERT INTO donor (id, name, avatar) VALUES (0, \'Anonymous donors\', \'images/unknown.png\')').run();
}

// SQL convenience functions
// Add a new donor or update an existing one
function db_addOrUpdateDonor(id, name, avatar) {
    // Insert a new donor into the donor table
    var query = 'INSERT INTO donor (id, name, avatar) VALUES ($id, $name, $avatar)';
    var params = {
        id: id,
        name: name,
        avatar: avatar
    };

    // Handle conflicts by updating the existing entry
    query += ' ON CONFLICT (id) DO UPDATE SET name = $name, avatar = $avatar';

    // Only update the existing entry if it's actually different
    query += ' WHERE name != $name OR avatar != $avatar';

    // Run the query
    db.prepare(query).run(params);
}

// Add a donation to the database
function db_addDonation(donorId, amount, timestamp) {
    var query = 'INSERT INTO donation (id, donorId, amount, timestamp) VALUES ($id, $donorId, $amount, $timestamp)';
    var params = {
        id: uuid(),
        donorId: donorId,
        amount: amount,
        timestamp: timestamp
    };

    // Run the query
    db.prepare(query).run(params);
}

// Get how much has been donated between the given start and end dates
function db_getFunds(startDate, endDate) {
    var query = 'SELECT SUM(amount) AS total FROM donation';
    var params = {};

    // Determine the kind of date filtering we'll be using
    if (startDate && endDate) { // Between two dates
        query += ' WHERE DATETIME(timestamp, \'unixepoch\', \'utc\') BETWEEN $startDate AND $endDate';
        params['startDate'] = startDate;
        params['endDate'] = endDate;
    } else if (startDate) { // After a certain date
        query += ' WHERE DATETIME(timestamp, \'unixepoch\', \'utc\') >= $startDate';
        params['startDate'] = startDate;
    } else if (endDate) { // Before a certain date
        query += ' WHERE DATETIME(timestamp, \'unixepoch\', \'utc\') <= $endDate';
        params['endDate'] = endDate;
    }

    // Run the query
    var total = db.prepare(query).get(params).total;
    return total ? total : 0;
}

// Get the top donators and how much they have donated between the given dates
// Returns an array of objects containing name, avatar, and total donation
// Format: [{name:str, avatar:str, total:float}, ...]
function db_getLeaderboard(startDate, endDate, limit = 10) {
    // Set up our initial statement and parameters
    // We will add to these as we build the query and execute it later
    var query = 'SELECT donorId, SUM(amount) AS total FROM donation';
    var params = {};

    // Determine what kind of date filtering we'll be using
    if (startDate && endDate) { // Between two dates
        query += ' WHERE DATETIME(timestamp, \'unixepoch\', \'utc\') BETWEEN $startDate AND $endDate';
        params['startDate'] = startDate;
        params['endDate'] = endDate;
    } else if (startDate) { // After a certain date
        query += ' WHERE DATETIME(timestamp, \'unixepoch\', \'utc\') >= $startDate';
        params['startDate'] = startDate;
    } else if (endDate) { // Before a certain date
        query += ' WHERE DATETIME(timestamp, \'unixepoch\', \'utc\') <= $endDate';
        params['endDate'] = endDate;
    }

    // Group by donor, order them by total donations, and limit to the top number of donors
    query += ' GROUP BY donorId ORDER BY SUM(amount) LIMIT $limit';
    params['limit'] = limit;

    // Wrap our query with a join to the donor table
    query = 'SELECT name, avatar, topDonors.total AS total FROM donor JOIN (' + query + ') AS topDonors ON topDonors.donorId = donor.id ORDER BY topDonors.total DESC';

    return db.prepare(query).all(params);
}

// Express middleware config
app.use(express.static(__dirname + '/static'));
app.use(bodyParser.urlencoded({extended: false}));
app.use(session({
    secret: 'someSecretIdkWhyIsThisSigned???',
    store: new sqlitestore,
    cookie: { maxAge: 8 * 7 * 24 * 60 * 60 * 1000 } // 8 weeks
}));
app.use(function(req, res, next){
    // Initialise the session's discord token if they haven't got one already
    if (!req.session.discordToken) req.session.discordToken = "";
    if (!req.session.discordRefreshToken) req.session.discordRefreshToken = "";

    // Move on to the next middleware
    next();
});

// Express routes
// Base route

// Discord authorisation
app.get('/discord/callback', function(req, res){
    // Validate our URL query strings
    if (req.query.hasOwnProperty('error') && req.query.error == 'access_denied') // Got '?error=access_denied'
        return res.status(400).send('<html><body onload="window.close()">Authorisation cancelled, you may now close this window.</body></html>');
    else if (req.query.hasOwnProperty('error')) // Got '?error=...'
        return res.status(400).send('<html><body onload="/*window.close()*/">Authorisation failed, you may now close this window.</body></html>');
    else if (!req.query.hasOwnProperty('code')) // Didn't get '?code=...'
        return res.status(400).send('<html><body onload="/*window.close()*/">Authorisation failed for an unknown reason.</body></html>');

    // Fill out the form data
    var options = {
        method: 'POST',
        uri: 'https://discordapp.com/api/oauth2/token',
        form: {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: req.query.code,
            scope: 'identify',
            redirect_uri: REDIRECT_URI
        },
        json: true
    };

    // Make the requst
    request(options)
        .then(function(json) {
            // Ensure we have an access token, failing the request otherwise
            if (!json.hasOwnProperty('access_token')) return res.status(500).send('<html><body onload="/*window.close()*/">Failed to get access token from Discord. This probably isn\'t your fault.</body></html>');

            // Save the token to the session
            req.session.discordToken = json.access_token;

            console.log("Got a token: " + req.session.discordToken);

            return res.status(200).send('<html><body onload="window.close()">Authorisation successful, you may now close this window.</body></html>');
        })
        .catch(function(err) {
            // Dump error to the console
            console.error(err);

            // Fail the request
            return res.status(500).send('<html><body onload="/*window.close()*/">Failed to get access token from Discord.</body></html>');
        });
});

// Check authorisation status
app.get('/discord/authorised', function(req, res) {
    // Return unauthorised if we don't have a token or if it's empty
    if (!req.session.hasOwnProperty('discordToken') || req.session.discordToken == '') return res.json({authorised: false});

    console.log('Checking auth with token: ' + req.session.discordToken);

    // Fill out the Discord form data
    var options = {
        method: 'GET',
        uri: 'https://discordapp.com/api/users/@me',
        headers: {
            'Authorization': 'Bearer ' + req.session.discordToken
        },
        json: true
    }

    // Try get the user's details from Discord with the token
    request(options)
        .then(function(json) {
            // Update the user's discord details
            req.session.discordId = json.id;
            req.session.discordName = json.username;
            req.session.discordAvatar = 'https://cdn.discordapp.com/avatars/' + json.id + '/' + json.avatar + '.png?size=128';

            // Add the user's details to the database
            db_addOrUpdateDonor(req.session.discordId, req.session.discordName, req.session.discordAvatar);

            return res.json({authorised: true});
        })
        .catch(function(err) {
            // Dump error to the console
            console.error(err);

            // Fail the request
            return res.status(500).json({authorised: false});
        });
});

// Get Discord name and avatar
app.get('/discord/profile', function(req, res) {
    // Fail the request if there isn't any data
    if (!req.session.hasOwnProperty('discordId') || !req.session.hasOwnProperty('discordName') || !req.session.hasOwnProperty('discordAvatar')) return res.status(404);

    // Return the user's name and avatar
    return res.json({
        id: req.session.discordId,
        name: req.session.discordName,
        avatar: req.session.discordAvatar
    });
});

// Process PayPal Instant Payment Notifications from donations
app.post('/paypal/donation', ipn.validator((err, content) => {
    // Check if the IPN failed validation
    if (err) {
        console.log(err);
        return;
    }

    // Log the donation
    if (content.custom) {
        console.log('Got a $' + content.mc_gross + ' ' + content.mc_currency + ' donation from Discord ID ' + content.custom);
    } else {
        console.log('Got an anonymous $' + content.mc_gross + ' ' + content.mc_currency + ' donation');
    }

    // Get the details
    var donorId = content.custom ? content.custom : 0;
    var amount = content.mc_gross;
    var timestamp = Math.floor(Date.now()/1000); // Epoch in seconds

    // Add donation to the database
    db_addDonation(donorId, amount, timestamp);
}, true)); // Production mode?

app.get('/api/donations', function(req, res) {
    // Get this month's date range
    var today = new Date();
    var endOfMonth = new Date(today.getFullYear(), today.getMonth()+1, 0);
    var monthStart = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-01';
    var monthEnd = endOfMonth.getFullYear() + '-' + ('0' + (endOfMonth.getMonth() + 1)).slice(-2) + '-' + ('0' + endOfMonth.getDate()).slice(-2);

    // Get this month's balance
    var balance = db_getFunds(monthStart, monthEnd);

    // Get this month's leaderboard
    var leaderboard = db_getLeaderboard(monthStart, monthEnd, 8);

    // Send this month's target, balance, and leaderboard
    return res.json({target: 140, balance: balance, leaderboard: leaderboard});
});

db_getLeaderboard();
console.log(db_getFunds('2011-01-01', '2012-01-01'));

// Start the app
app.listen(PORT);
console.log('Express server listening on port %d in %s mode', PORT, app.settings.env);

// Close the database when we're done
process.on('exit', () => db.close());
process.on('SIGHUP', () => process.exit(128 + 1));
process.on('SIGINT', () => process.exit(128 + 2));
process.on('SIGTERM', () => process.exit(128 + 15));

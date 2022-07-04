// Config variables
var CLIENT_ID = process.env.CLIENT_ID;
var CLIENT_SECRET = process.env.CLIENT_SECRET;
var DB_URI = process.env.DB || "sqlite://./db/donations.db";
var PORT = process.env.PORT || 8080;
var BASE_REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:8080";

// Node module imports
var express = require('express');
var session = require('express-session');
var sessionStore = require('express-session-sequelize')(expressSession.Store);
var request = require('request-promise');
var ipn = require('express-ipn');
var bodyParser = require('body-parser');
var sequelize = require('sequelize');
var uuid = require('uuid/v4');

// Node module instantiation
var app = express();
var db = new sequelize(DB_URI);
var sequelizeSessionStore = new sessionStore({db: db});

var donors = db.define("donor", {
    id: {
        type: sequelize.INTEGER,
        primaryKey: true
    },
    name: {
        type: sequelize.TEXT,
        allowNull: false
    },
    avatar: {
        type: sequelize.TEXT,
        allowNull: false
    },
},
{
    timestamps: false,
});

var txns = db.define("transactions", {
    id: {
        type: sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    amount: {
        type: sequelize.REAL,
        allowNull: false
    },
    fee: {
        type: sequelize.REAL,
        allowNull: false
    },
    timestamp: {
        type: sequelize.INTEGER,
        allowNull: false
    },
},
{
    timestamps: false,
});

txns.hasOne(donors);
donors.sync;
txns.sync;

// Make sure the anonymous donor exists
var anonymousDonorId = donors.findAll({where: {id: 0}}); // db.prepare('SELECT id FROM donor WHERE id = 0').get();
if (!anonymousDonorId) {
    db.prepare('INSERT INTO donor (id, name, avatar) VALUES (0, \'Anonymous donors\', \'images/unknown.png\')').run();
}

// SQL convenience functions

// Get how much has been donated between the given start and end dates
// TODO: Convert to Sequelize
function db_getFunds(startDate, endDate) {
    var query = 'SELECT SUM(amount - fee) AS total FROM transactions';
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

// Get how much has been sucked out by PayPal between the given start and end dates
// TODO: Convert to Sequelize
function db_getFees(startDate, endDate) {
    var query = 'SELECT SUM(fee) AS total FROM transactions';
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

// Get the total amount donated between the given start and end dates
// TODO: Convert to Sequelize
function db_getDonated(startDate, endDate) {
    var query = 'SELECT SUM(amount - fee) AS total FROM transactions';
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

    // Ignore payments
    query += ' AND donorId IS NOT NULL';

    // Run the query
    var total = db.prepare(query).get(params).total;
    return total ? total : 0;
}

// Get the top donators and how much they have donated between the given dates
// Returns an array of objects containing name, avatar, and total donation
// Format: [{name:str, avatar:str, total:float}, ...]
// TODO: Convert to Sequelize
function db_getLeaderboard(startDate, endDate, limit = 10) {
    // Set up our initial statement and parameters
    // We will add to these as we build the query and execute it later
    var query = 'SELECT donorId, SUM(amount - fee) AS total, SUM(fee) AS fees FROM transactions WHERE donorId IS NOT NULL';
    var params = {};

    // Determine what kind of date filtering we'll be using
    if (startDate && endDate) { // Between two dates
        query += ' AND DATETIME(timestamp, \'unixepoch\', \'utc\') BETWEEN $startDate AND $endDate';
        params['startDate'] = startDate;
        params['endDate'] = endDate;
    } else if (startDate) { // After a certain date
        query += ' AND DATETIME(timestamp, \'unixepoch\', \'utc\') >= $startDate';
        params['startDate'] = startDate;
    } else if (endDate) { // Before a certain date
        query += ' AND DATETIME(timestamp, \'unixepoch\', \'utc\') <= $endDate';
        params['endDate'] = endDate;
    }

    // Group by donor, order them by total donations, and limit to the top number of donors
    query += ' GROUP BY donorId ORDER BY SUM(amount - fee) LIMIT $limit';
    params['limit'] = limit;

    // Wrap our query with a join to the donor table
    query = 'SELECT name, avatar, topDonors.total AS total, topDonors.fees AS fees FROM donor JOIN (' + query + ') AS topDonors ON topDonors.donorId = donor.id ORDER BY topDonors.total DESC';

    return db.prepare(query).all(params);
}

// Express middleware config
app.use(express.static(__dirname + '/static'));
app.use(bodyParser.urlencoded({extended: false}));
app.use(session({
    secret: 'someSecretIdkWhyIsThisSigned???',
    store: sequelizeSessionStore,
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
            redirect_uri: BASE_REDIRECT_URI + '/discord/callback'
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
            donors.upsert({
                id: req.session.discordId,
                name: req.session.discordName,
                avatar: req.session.discordAvatar
            });

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
        console.error(err);
        return;
    }

    // Dump the IPN to the terminal
    console.log('==================================');
    console.log('============ BEGIN IPN ===========');
    console.log('==================================');
    console.log(content);
    console.log('==================================');
    console.log('============= END IPN ============');
    console.log('==================================');

    // Get the details
    var donorId = content.custom ? content.custom : 0;
    var amount = content.mc_gross;
    var fee = content.mc_fee;
    var timestamp = Math.floor(Date.now()/1000); // Epoch in seconds

    // Check if this was a payment
    if (content.mc_gross == -140) {
        // Add a payment
        txns.create({
            amount: amount,
            fee: fee,
            timestamp: timestamp
        });
    } else {
        // Log the donation
        if (donorId != 0) {
            console.log('Got a $' + (amount - fee) + ' ' + content.mc_currency + ' (' + amount + ' - ' + fee + ') donation from Discord ID ' + donorId);
        } else {
            console.log('Got an anonymous $' + content.mc_gross + ' ' + content.mc_currency + ' donation');
        }

        // Add donation to the database
        txns.create({
            donorId: donorId,
            amount: amount,
            fee: fee,
            timestamp: timestamp
        })
    }

}, true)); // Production mode?

app.get('/api/donations', function(req, res) {
    // Get this month's date range
    var today = new Date();
    var endOfMonth = new Date(today.getFullYear(), today.getMonth()+1, 0);
    var monthStart = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-01';
    var monthEnd = endOfMonth.getFullYear() + '-' + ('0' + (endOfMonth.getMonth() + 1)).slice(-2) + '-' + ('0' + endOfMonth.getDate()).slice(-2);

    // Get this month's fees, leaderboard, and current balance
    var fees = db_getFees(monthStart, monthEnd);
    var leaderboard = db_getLeaderboard(monthStart, monthEnd, 8);
    var balance = db_getFunds('', monthEnd);
    var thisMonth = db_getDonated(monthStart, monthEnd);

    // Send this month's target, balance, and leaderboard
    return res.json({target: 140, balance: balance, thisMonth: thisMonth, fees: fees, leaderboard: leaderboard});
});

// Start the app
app.listen(PORT);
console.log('Express server listening on port %d in %s mode', PORT, app.settings.env);

// Close the database when we're done
process.on('exit', () => db.close());
process.on('SIGHUP', () => process.exit(128 + 1));
process.on('SIGINT', () => process.exit(128 + 2));
process.on('SIGTERM', () => process.exit(128 + 15));

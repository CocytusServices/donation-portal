// Define the base API URI without the trailing slash
var BASE_REDIRECT_URI = 'https://donate.cocytus.services';

// Define and initialise up the form
var form = new Vue({
    el: '#container',
    data: {
        formDisplayed: true,
        anonymous: false,
        authorised: false,
        locked: false,
        discordId: '',
        discordName: '',
        discordAvatar: '',
        amount: 0,
        donationTarget: 0,
        donationBalance: 0,
        donationBalanceThisMonth: 0,
        donationFees: 0,
        donationLeaderboard: null,
        donationProgressDollars: true,
        moneyFormat: {
            decimal: '.',
            thousands: ',',
            prefix: 'AU$',
            suffix: '',
            precision: 2,
            masked: false
        },
        refreshTimer: null
    },
    methods: {
        openDiscordPopout: function() {
            // Open the popup
            var w = window.open(
                'https://discordapp.com/api/oauth2/authorize?client_id=631115320823644180&redirect_uri=' + encodeURIComponent(BASE_REDIRECT_URI) + '%2Fdiscord%2Fcallback&response_type=code&scope=identify',
                'Authorise with Discord',
                'width=375,height=485,top=' + ((window.innerHeight / 2) - 200) + ',left=' + ((window.innerWidth / 2) - 187)
            );

            // Handle the popup closing to refresh our authorised state
            // Hacky, but it works for all origins, not just the site we're hosting
            const vueInstance = this; // Necessary since 'this' becomes the DOM
            var timer = setInterval(function() {
                if (w.closed) {
                    // Stop the timer and check our auth state
                    clearInterval(timer);
                    vueInstance.checkIfAuthorised();
                }
            }, 250);
        },
        checkIfAuthorised: function() {
            // Get the authorised status from the API and parse it as JSON
            this.$http.get('/discord/authorised').then(res => {return res.json()}).then(json => {
                // Update the authorised state
                this.authorised = json.authorised;

                // Update our name and avatar according to our auth state
                if (json.authorised) {
                    this.updateDiscordDetails();
                } else {
                    this.discordId = '';
                    this.discordName = '';
                    this.discordAvatar = '';
                }
            });
        },
        updateDiscordDetails: function() {
            this.$http.get('/discord/profile').then(res => {return res.json()}).then(json => {
                // Update our name and avatar
                this.discordId = json.id;
                this.discordName = json.name;
                this.discordAvatar = json.avatar;
            });
        },
        openPaypalPopout: function() {
            // Don't do anything if we don't have a donation ID
            if (!this.anonymous && !this.discordId) return;

            // Construct a button URL
            var url = 'https://www.paypal.com/cgi-bin/webscr' +
                        '?cmd=_donations' +                                                           // This is a donation
                        '&business=paypal@cocytus.services' +                                         // Send it to Cocytus Services
                        '&item_name=Keep Cocytus up and running' +                                    // Donation cause/name
                        '&no_note=1' +                                                                // Disable the note field
                        '&currency_code=AUD' +                                                        // Accept AUD
                        '&amount=' + this.amount +                                                    // The donation amount in dollars
                        '&notify_url=' + encodeURIComponent(BASE_REDIRECT_URI + '/paypal/donation') + // The return URL to send confirmation to
                        '&image_url=https://cocytus.services/logo.png' +                                // Image shown as the recipient's icon (SFP Logo)
                        (this.anonymous ? '' : '&custom=' + this.discordId);                          // Pass our Discord ID to verify who made the donation (if not anonymous)

            // Lock the form
            this.locked = true;

            // Open the popup
            var w = window.open(
                url,
                'Donate with PayPal',
                'width=375,height=485,top=' + ((window.innerHeight / 2) - 200) + ',left=' + ((window.innerWidth / 2) - 187)
            );

            // Handle the popup closing to refresh the donation pool
            // Hacky, but it works for all origins, not just the site we're hosting
            const vueInstance = this; // Necessary since 'this' becomes the DOM
            var timer = setInterval(function() {
                if (w.closed) {
                    // Stop the timer, finish the donation, and refresh the donation panel
                    clearInterval(timer);
                    // TODO: Refresh donation panel

                    // Reset the donation amount and unlock the form
                    vueInstance.amount = 0;
                    vueInstance.locked = false;
                }
            }, 250);
        },
        getDonations: function() {
            this.$http.get('/api/donations').then(res => {return res.json()}).then(json => {
                // Update our target and donor list
                this.donationTarget = json.target;
                this.donationBalance = json.balance;
                this.donationBalanceThisMonth = json.thisMonth;
                this.donationFees = json.fees;
                this.donationLeaderboard = json.leaderboard;
            });
        },
        formatFee: function(fee) {
            return fee != 0 ? 'PayPal has skimmed ' + this.$options.filters.currency(fee) : 'PayPal hasn\'t skimmed any fees (yet)';
        }
    },
    created: function() {
        // Start the refresh timer
        var vueInstance = this; // Necessary since 'this' becomes the DOM
        this.refreshTimer = setInterval(() => {
            vueInstance.getDonations();
        }, 15000);

        // Get our initial state
        this.getDonations();
        this.checkIfAuthorised();
    }
});

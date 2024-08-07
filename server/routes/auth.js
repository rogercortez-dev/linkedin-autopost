const express = require('express');
const axios = require('axios');
const router = express.Router();
const querystring = require('querystring');
require('dotenv').config();
const pool = require('../db.js');  // Import the MySQL connection pool
const jwt = require('jsonwebtoken'); // used to decode the id_token(JWT token) and extract user's LinkedIn profile information
const jwksClient = require('jwks-rsa');

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_AUTH_CALLBACK_URL = process.env.GITHUB_AUTH_CALLBACK_URL;

const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const LINKEDIN_CALLBACK_URL = process.env.LINKEDIN_CALLBACK_URL;

// Redirect the user to GitHub's OAuth authorization page
router.get('/github', (req, res) => {
    const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${GITHUB_AUTH_CALLBACK_URL}&scope=repo`;
    res.redirect(githubAuthUrl);
});

// Handle the callback from GitHub and exchange the authorization code for an access token
router.get('/github/callback', async (req, res) => {
    // Temporary code provided by GitHub which will expire after 10 minutes.
    const { code } = req.query;

    try {
        // Exchange the authorization code for an access token
        const tokenResponse = await axios.post('https://github.com/login/oauth/access_token', null, {
            params: {
                client_id: GITHUB_CLIENT_ID,
                client_secret: GITHUB_CLIENT_SECRET,
                code
            },

            headers: {
                Accept: 'application/json'
            },
        });
        // Extract the access token
        const accessToken = tokenResponse.data.access_token;

        // Fetch user information from GitHub using the fetched access token
        const githubResponse = await axios.get('https://api.github.com/user', {
            headers: {
                Authorization: `token ${accessToken}`
            }
        });
        // Extract the user's GitHub username
        const githubUsername = githubResponse.data.login;
        const githubProfileUrl = githubResponse.data.avatar_url;
        console.log(githubResponse.data);
        console.log(githubUsername);

        // If such an account has already existed, login the user directly
        // Otherwise, save the GitHub credentials and proceed to create a new account 
        const [rows, fields] = await pool.query('SELECT * FROM users WHERE github_username = ?', [githubUsername]);

        console.log(`DB query rows for the given githubusername ${githubUsername} :`, rows);
        console.log(`DB query fields for the given githubusername ${githubUsername} :`, fields);
        // DB query results for the given githubusername arthurmorgan-dev : 
        // [
        //     [],
        //     [
        //         `id` INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
        //         `github_username` VARCHAR(255) UNIQUE_KEY,
        //         `linkedin_id` VARCHAR(255) UNIQUE_KEY,
        //         `github_token` TEXT,
        //         `linkedin_token` TEXT,
        //         `created_at` TIMESTAMP(19)
        //     ]
        // ]

        // DONOT use results.length > 0, since its length will always be greater than 0
        if (rows.length > 0) { 
            // Save the user info in the session store
            // Each time the user finishes the authentication, a new accessToken will be generated, 
            // thus we need to update the original github_token with this new accessToken

            try {
                // Get a connection from the pool
                const connection = await pool.getConnection();
                try {   
                    // Start a transaction
                    await connection.beginTransaction();

                    // Perform the UPDATE operation to refresh github_token
                    await connection.query('UPDATE users SET github_token = ?, github_profileurl = ? WHERE github_username = ?', [accessToken, githubProfileUrl, githubUsername]);

                    // Perform a SELECT query to retrieve the updated row data
                    const [updatedRows, updatedFields] = await connection.query('SELECT * FROM users WHERE github_username = ?', [githubUsername]);
                    console.log('If the user already exists, update the github_token with the new one.');
                    console.log('The updated rows returned by MySQL server after executing the UPDATE clause:', updatedRows);
                    console.log('The updated fields returned by MySQL server after executing the UPDATE clause:', updatedFields);

                    // Commit the transaction
                    await connection.commit();

                    req.session.user = updatedRows;
                    req.session.save((err) => {
                        if (err) {
                            console.error('Session save error:', err);
                            res.redirect('/users/login?error=sessionError');
                        } else {
                            console.log('Session saved successfully!');
                            res.redirect('/');
                        }
                    });

                } catch (error) {
                    // Rollback the transaction in case of error
                    await connection.rollback();
                    console.error('Error during transaction:', error);
                } finally {
                    // Release the connection back to the pool
                    connection.release();
                }
            } catch (poolError) {
                console.error('Error getting connection from pool:', poolError);
            }

           
        } else {
            // Store Github username and access token in session for later use with LinkedIn OAuth
            req.session.githubUsername = githubUsername;
            req.session.githubAccessToken = accessToken;
            req.session.githubProfileUrl = githubProfileUrl;
            req.session.save((err) => {
                if (err) {
                    console.log('Error saving session data:', err);
                } else {
                    console.log('Session data saved successfully.');
                    // Redirect to the registration page with the GitHub username
                    res.redirect(`/users/register?githubUsername=${githubUsername}`);
                }
            });
        }

       


    } catch (error) {
        console.error('Error during gitHub authentication:', error);
        // If the authorization process failed, redirect the user to the registration page with an error message
        res.redirect(`/users/register?error=githubAuthFailed`);
    }
});

// Redirect the user to LinkedIn's OAuth page 
router.get('/linkedin', (req, res) => {
    try {
        // Need to add the scope w_member_social in order to make posts on behalf of the user
        const linkedinAuthUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(LINKEDIN_CALLBACK_URL)}&scope=openid%20profile%20email%20w_member_social`;
        // extra scope that needs company page verification: %20w_member_social  r_liteprofile, r_emailaddress, and w_member_social  
        // &scope=openid%20profile%20email

        res.redirect(linkedinAuthUrl);
    } catch (error) {
        console.error('Error during LinkedIn authorization:', error);
        // Redirect the user back to the registration page
        res.redirect(`/users/register?githubUsername=${req.session.githubUsername}&error=linkedinAuthFailed`);
    }
});

// Helper function to get the sigining key from LinkedIn
const client = jwksClient({
    jwksUri: 'https://www.linkedin.com/oauth/openid/jwks'
});

function getKey(header, callback) {
    client.getSigningKey(header.kid, function (err, key) {
        const signingKey = key.publicKey || key.rsaPublicKey;
        callback(null, signingKey);
    });
};

// Handle the callback from LinkedIn and exchange the authorization code for an access token
router.get('/linkedin/callback', async (req, res) => {
    // Extract the temporary authorization code from LinkedIn
    const { code } = req.query;
    const { githubUsername, githubAccessToken, githubProfileUrl } = req.session;

    try {
        // Exchange the authorization code for an access token
        const params = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            client_id: LINKEDIN_CLIENT_ID,
            client_secret: LINKEDIN_CLIENT_SECRET,
            redirect_uri: LINKEDIN_CALLBACK_URL
        }).toString();

        const tokenResponse = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', params, {
            headers: {
                'Content-Type' : 'application/x-www-form-urlencoded',
            }
        });

        // Extract the access token from the response data
        const accessToken = tokenResponse.data.access_token; // Valid within 60 days
        console.log(tokenResponse.data);
        const openidToken = tokenResponse.data.id_token;
        console.log('Received openid token:', openidToken);

        // Verify the JWT openid token and extract user data from it
        // var decodedUserData;
        jwt.verify(openidToken, getKey, async (err, decoded) => {
            if (err) {
                console.error('Error verifying openid token:', err);
                res.redirect(`/users/register?githubUsername=${githubUsername}&error=openidTokenVerificationFailed`);
            }

            // Access verified claims
            // decodedUserData = decoded;
            const { sub, name, email, picture } = decoded;
            const linkedinId = sub; // user id
            console.log('Decoded user data:', decoded);
            console.log('Github username fetched from session store:', githubUsername);
            console.log('Github access token fetched from session store:', githubAccessToken);

            // If such an account already exists, login the user directly
            try {
                const [rows, fields] = await pool.query('SELECT * FROM users WHERE linkedin_id = ?', [linkedinId]);
                console.log('Database query rows when login via LinkedIn:', rows);
                console.log('Database query fields when login via LinkedIn:', fields);

                if (rows.length > 0) {
                    // If the user's account already exists, we need to refresh the linkedin_token first, 
                    // since we have a new one each time the user finishes the authentication from LinkedIn
                    try {
                        // Get a connection from the pool
                        const connection = await pool.getConnection();

                        try {
                            // Start a transaction
                            await connection.beginTransaction();

                            // Perform the UPDATE operation to refresh linkedin_token
                            await connection.query('UPDATE users SET linkedin_token = ? WHERE linkedin_id = ?', [accessToken, linkedinId]);

                            // Perform the SELECT query to fetch the updated row
                            const [updatedRows, updatedFields] = await connection.query('SELECT * FROM users WHERE linkedin_id = ?', [linkedinId]);
                            console.log('If the user already exists, update the linkedin_token with the new one.');
                            console.log('The updated rows returned by MySQL server after executing the UPDATE clause:', updatedRows);
                            console.log('The updated fields returned by MySQL server after executing the UPDATE clause:', updatedFields);

                            // Commit the transaction
                            await connection.commit();

                            // Update sesstion store
                            req.session.user = updatedRows;
                            req.session.save((err) => {
                                if (err) {
                                    console.error('Error during session store:', err);
                                    res.redirect('/users/login?error=sessionError');
                                } else {
                                    console.log('Session saved successfully!');
                                    res.redirect('/');
                                }
                            });

                        } catch (error) {
                            // Rollback the transaction in case of error
                            await connection.rollback();
                            console.error('Error during transaction:', error);
                        } finally {
                            // Release the connection back to the pool
                            connection.release();
                        }

                    } catch (poolError) {
                        console.error('Error getting connection from pool:', poolError);
                    }

                } else {
                    // Otherwise, retrieve the github credentials from session store and save all of them in local DB
                    await pool.query(
                        'INSERT INTO users (github_username, linkedin_id, github_token, linkedin_token, github_profileurl) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE github_token = VALUES(github_token), linkedin_token = VALUES(linkedin_token), github_profileurl = VALUES(github_profileurl)',
                        [githubUsername, linkedinId, githubAccessToken, accessToken, githubProfileUrl]
                    );
    
                    // Once it's done, there's no need to keep the session data, destroy them.
                    req.session.destroy((err) => {
                        if (err) {
                            console.error('Error destroying session data:', err);
                        } else {
                            console.log('Session data destroyed successfully.');
                        }
                    });
    
                    // Redirect to the registration page with the GitHub username and LinkedIn id
                    res.redirect(`/users/register?githubUsername=${githubUsername}&linkedinId=${linkedinId}`);
                }

            } catch (dbError) {
                console.error('Database query error:', dbError);
            }


        });

        // const { sub } = decodedUserData;
        // const linkedinId = sub; // user id
        // console.log(decodedUserData);

        // Now we can use the access token to fetch the user's profile information
        // data: {
        //     status: 403,
        //     serviceErrorCode: 100,
        //     code: 'ACCESS_DENIED',
        //     message: 'Not enough permissions to access: me.GET.NO_VERSION'
        // }
        // const profileResponse = await axios.get('https://api.linkedin.com/v2/me', {
        //     headers: {
        //         Authorization: `Bearer ${accessToken}`
        //     }
        // });
        // const linkedinId = profileResponse.data.id;

    } catch (error) {
        console.error('Error during LinkedIn access token exchanging:', error);
        // If the authorization process failed, redirect the user back to the registration page with an error message
        // Since the user has already done the GitHub authorization, we need to include the githubUsername here
        res.redirect(`/users/register?githubUsername=${req.session.githubUsername}&error=linkedinAuthFailed`);
    }
});


module.exports = router;
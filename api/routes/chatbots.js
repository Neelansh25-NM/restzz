const express = require('express');
const router = express.Router();
const db = require('../database.js');
const { GoogleGenAI } = require('@google/genai');
const jwt = require('jsonwebtoken');
const { rankByConvenience } = require('../utils/scoring');

function getAIClient() {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === 'YOUR_GEMINI_API_KEY' || key.trim() === '') {
        return null;
    }
    return new GoogleGenAI({ apiKey: key.trim() });
}

function getModelName() {
    return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
}

function extractReplyText(response) {
    if (!response) return '';

    if (typeof response.text === 'string' && response.text.trim()) return response.text.trim();
    if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();

    const candidates = response.candidates || response.response?.candidates || [];
    const textFromCandidates = candidates
        .map(candidate => {
            const parts = candidate?.content?.parts || candidate?.parts || [];
            return parts
                .map(part => part?.text || '')
                .join('')
                .trim();
        })
        .filter(Boolean)
        .join('\n')
        .trim();

    if (textFromCandidates) return textFromCandidates;

    return '';
}

function isTopicRelevant(message) {
    const text = (message || '').toLowerCase().trim();
    if (!text) return false;

    // Friendly keywords including food recommendations, cravings, dining vibes, and app functions
    const allowedKeywords = [
        'reservation', 'reserve', 'book', 'booking', 'table', 'tables', 'queue', 'waitlist', 'waiting',
        'wait time', 'restaurant', 'restaurants', 'location', 'locations', 'food', 'menu', 'dining',
        'seating', 'seat', 'check-in', 'cancel', 'line', 'table availability', 'opening time', 'hours',
        'service', 'order', 'pickup', 'bar', 'cafe', 'lounge', 'restaurant info', 'cuisine', 'meal',
        'reservation status', 'queue status', 'available table', 'join queue', 'dinner', 'lunch', 'breakfast',
        'brunch', 'eat', 'dine', 'have dinner', 'have lunch', 'food place', 'restaurant booking', 'table for',
        'reserve a table', 'book a table', 'booking a table', 'join the queue', 'queue for', 'waitlist for',
        'estimated wait', 'estimated wait time', 'hungry', 'recommend', 'suggestion', 'popular', 'best',
        'tasty', 'delicious', 'vibe', 'what to eat', 'where to go', 'chinese', 'asian', 'indian', 'continental',
        'party', 'date', 'friends', 'family', 'budget', 'price', 'special'
    ];

    const greetingKeywords = ['hi', 'hello', 'hey', 'sup', 'yo', 'good morning', 'good evening', 'thanks', 'thank you', 'howdy', 'what\'s up'];
    const generalHelpKeywords = ['help', 'can you help', 'what can you do', 'how do i', 'where can i', 'who are you', 'tell me'];

    const containsPhrase = (keyword) => {
        const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^a-z])${escapedKeyword}(?=$|[^a-z])`).test(text);
    };

    return allowedKeywords.some(containsPhrase) || greetingKeywords.some(containsPhrase) || generalHelpKeywords.some(containsPhrase);
}

router.post('/message', async (req, res, next) => {
    try {
        const { message, userId } = req.body;
        const authorization = req.headers.authorization || '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        let authenticatedUserId = null;

        if (token) {
            try {
                authenticatedUserId = jwt.verify(token, process.env.JWT_SECRET).customer_id;
            } catch (error) {
                return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
            }
        }

        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: 'Message content is required.' });
        }

        if (!isTopicRelevant(message)) {
            return res.json({
                reply: "Hey! 🍽️ I'm your Q-Sense dining buddy. I'm all about helping you find yummy food spots, grab a table, skip long queues, or answer questions about our restaurants. Tell me what you're craving!"
            });
        }

        const ai = getAIClient();
        const model = getModelName();

        if (!ai) {
            return res.json({
                reply: "Hey there! 👋 I'm your Q-Sense dining buddy! 😊 I'm almost ready to chat, recommend dishes, and find you great tables — please add your Google AI Studio Gemini API key to `.env` as `GEMINI_API_KEY` to activate me!"
            });
        }

        // Fetch live database context
        const [restaurantRows] = await db.query(`
            SELECT r.restaurant_id, r.name, r.location, r.status,
                   COUNT(t.table_id) FILTER (WHERE t.status = 'vacant') AS vacant_tables,
                   COUNT(t.table_id) FILTER (WHERE t.status = 'occupied') AS occupied_tables,
                   COUNT(t.table_id) FILTER (WHERE t.status = 'reserved') AS reserved_tables,
                   COUNT(t.table_id) AS total_tables
            FROM restaurant r
            LEFT JOIN restaurant_tables t ON t.restaurant_id = r.restaurant_id
            GROUP BY r.restaurant_id, r.name, r.location, r.status
            ORDER BY r.name ASC
        `);

        // Fetch active queue counts per restaurant
        const [queueCounts] = await db.query(`
            SELECT restaurant_id, COUNT(*) AS waiting_count
            FROM queue
            WHERE status = 'waiting'
            GROUP BY restaurant_id
        `);
        const queueMap = new Map(queueCounts.map(q => [q.restaurant_id, parseInt(q.waiting_count, 10)]));

        const enrichedRestaurants = restaurantRows.map(r => ({
            id: r.restaurant_id,
            name: r.name,
            location: r.location,
            status: r.status,
            vacant_tables: parseInt(r.vacant_tables || 0, 10),
            occupied_tables: parseInt(r.occupied_tables || 0, 10),
            reserved_tables: parseInt(r.reserved_tables || 0, 10),
            waiting_in_queue: queueMap.get(r.restaurant_id) || 0,
            estimated_wait_minutes: (queueMap.get(r.restaurant_id) || 0) * 5
        }));

        let queueRows = [];
        let reservationRows = [];

        if (userId && authenticatedUserId && String(userId) === String(authenticatedUserId)) {
            [queueRows, reservationRows] = await Promise.all([
                db.query(
                    `SELECT q.queue_id, q.restaurant_id, q.group_size, q.status,
                            q.joined_at, r.name AS restaurant_name,
                            CASE WHEN q.status IN ('waiting', 'called') THEN
                                ROW_NUMBER() OVER (
                                    PARTITION BY q.restaurant_id
                                    ORDER BY q.joined_at ASC
                                )
                            END AS position,
                            CASE WHEN q.status IN ('waiting', 'called') THEN
                                ROW_NUMBER() OVER (
                                    PARTITION BY q.restaurant_id
                                    ORDER BY q.joined_at ASC
                                ) * 5
                            END AS estimated_wait_minutes
                     FROM queue q
                     JOIN restaurant r ON r.restaurant_id = q.restaurant_id
                     WHERE q.customer_id = $1 AND q.status IN ('waiting', 'called')
                     ORDER BY q.joined_at ASC`,
                    [userId]
                ).then(([rows]) => rows),
                db.query(
                    `SELECT res.reserve_id, res.restaurant_id, res.reserve_date,
                            res.reserve_time, res.group_size, res.status,
                            r.name AS restaurant_name
                     FROM reservation res
                     JOIN restaurant r ON r.restaurant_id = res.restaurant_id
                     WHERE res.customer_id = $1 AND res.status = 'reserved'
                       AND (res.reserve_date > CURRENT_DATE OR (res.reserve_date = CURRENT_DATE AND res.reserve_time >= CURRENT_TIME))
                     ORDER BY res.reserve_date ASC, res.reserve_time ASC`,
                    [userId]
                ).then(([rows]) => rows)
            ]);
        }

        const liveContext = JSON.stringify({
            availableRestaurants: enrichedRestaurants,
            userActiveQueues: queueRows,
            userUpcomingReservations: reservationRows
        });

        const systemInstruction = `
You are a chatbot for a customer restaurant booking and live queue tracking system named Q-Sense.
You have a warm, sociable, upbeat, and genuinely friendly nature designed to make restaurant bookers and diners feel completely at ease, welcomed, and excited about dining out. You connect with them like an enthusiastic, knowledgeable foodie buddy who loves good eats and hates waiting in lines.

Your Personality & Voice:
- Approachable, cheerful, and conversational (use light, tasty emojis like 🍽️, 😋, ✨, 🍷, 🚶‍♂️, 🍕).
- Put diners at ease: whether they're booking a cozy date for two, managing a big friends' hangout, or looking to grab a quick bite without the headache of long queues.
- Be proactive with popular and helpful recommendations based on real restaurants in Q-Sense:
  * "Foo Bandra" — beloved for exquisite Asian dishes, dim sums, sushi, and trendy vibes.
  * "Copper Chimney" — iconic for rich North Indian flavors, tandoor specials, and family meals.
  * "Bandra Born" & "Veranda Bandra" — top picks for modern regional Indian dining and cocktails.
  * "The Nest Bandra" & "Q-Sense HQ Diner" — cozy spots for hearty Continental comfort food.

Core Responsibilities:
1. Help diners choose where to eat based on cuisine cravings (Asian, Indian, Continental), party size, or mood.
2. Give real-time table availability using the live data below (vacant vs occupied/reserved tables).
3. Inform diners about current live waitlist lines and estimated wait times (~5 min per party in line).
4. Guide diners on how to reserve a table (via the "Reservation" tab) or join the live walk-in queue (via "Locations" or "Join Live Queue").
5. Check on the diner's personal bookings or queue status if they ask.

Current Live Database & System Context:
${liveContext}

Guidelines:
- Keep answers concise, natural, and friendly (around 2 to 4 sentences or a neat bulleted list, under 120 words).
- Always base table counts, wait times, and restaurant names strictly on the live data context provided.
- If a place is full or has a long wait, suggest a great alternative with 0 wait from the open restaurants list!
- Conclude with a warm, buddy-like check-in (e.g. "Want me to help you pick a table or check the queue for tonight?").
`;

        const response = await ai.models.generateContent({
            model,
            contents: message,
            config: {
                systemInstruction,
                maxOutputTokens: 600,
                temperature: 0.65
            }
        });

        const reply = extractReplyText(response) || "I'm having a little trouble connecting with the kitchen right now, but feel free to ask again in a moment!";
        console.log('Gemini buddy reply for:', message, '=>', reply);

        res.json({ reply });
    } catch (error) {
        console.error('Chatbot error:', error);

        if (error?.status === 404 || error?.error?.code === 404 || error?.message?.includes('not found')) {
            return res.status(502).json({
                error: `The configured Gemini model is unavailable. Ensure GEMINI_MODEL in .env is set to 'gemini-2.5-flash' or 'gemini-1.5-flash'.`
            });
        }

        res.status(500).json({ error: 'Sorry! The AI assistant ran into an unexpected hiccup. Please try again.' });
    }
});


// ============================================================
// Function-calling: let the chatbot actually book a table or
// join a queue, instead of only answering questions about them.
// ============================================================
function extractFunctionCall(response) {
    if (!response) return null;

    if (Array.isArray(response.functionCalls) && response.functionCalls.length > 0) {
        return response.functionCalls[0];
    }

    const candidates = response.candidates || response.response?.candidates || [];
    for (const candidate of candidates) {
        const parts = candidate?.content?.parts || candidate?.parts || [];
        for (const part of parts) {
            if (part?.functionCall) return part.functionCall;
        }
    }
    return null;
}

function resolveRestaurantByName(name, restaurantRows) {
    if (!name) return null;
    const normalized = name.trim().toLowerCase();

    let match = restaurantRows.find((r) => r.name.toLowerCase() === normalized);
    if (match) return match;

    match = restaurantRows.find((r) =>
        r.name.toLowerCase().includes(normalized) || normalized.includes(r.name.toLowerCase())
    );
    return match || null;
}

const bookTableDeclaration = {
    name: 'book_table',
    description: 'Books a table reservation for the currently logged-in customer at a specific restaurant, date, and time.',
    parameters: {
        type: 'OBJECT',
        properties: {
            restaurant_name: { type: 'STRING', description: "The restaurant's name, as the user said it." },
            group_size: { type: 'INTEGER', description: 'Number of people in the party.' },
            reserve_date: { type: 'STRING', description: 'Reservation date in YYYY-MM-DD format. Resolve relative dates like "tonight" or "tomorrow" to an actual date.' },
            reserve_time: { type: 'STRING', description: 'Reservation time in 24-hour HH:MM format.' }
        },
        required: ['restaurant_name', 'group_size', 'reserve_date', 'reserve_time']
    }
};

const joinQueueDeclaration = {
    name: 'join_queue',
    description: 'Joins the currently logged-in customer to the live walk-in waitlist at a specific restaurant, right now.',
    parameters: {
        type: 'OBJECT',
        properties: {
            restaurant_name: { type: 'STRING', description: "The restaurant's name, as the user said it." },
            group_size: { type: 'INTEGER', description: 'Number of people in the party.' }
        },
        required: ['restaurant_name', 'group_size']
    }
};

// ── POST /api/chatbots/action ────────────────────────────────────────
// Separate from /message (which stays pure Q&A) so this higher-stakes,
// harder-to-fully-verify-offline path can't destabilize the working
// chatbot. Requires login — booking/joining a queue always needs a
// real customer_id.
//
// NOTE: function-calling response shapes can vary slightly between
// @google/genai SDK versions. extractFunctionCall() above checks both
// the convenience `.functionCalls` array and the raw candidates/parts
// structure defensively, but this endpoint hasn't been exercised
// against a live API key in this environment (no network access here)
// — test it for real before relying on it, same caution as any new
// third-party API integration.
router.post('/action', async (req, res) => {
    try {
        const { message } = req.body;
        const authorization = req.headers.authorization || '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

        if (!token) {
            return res.status(401).json({ error: 'Please log in to book a table or join a queue through the chatbot.' });
        }

        let customerId;
        try {
            customerId = jwt.verify(token, process.env.JWT_SECRET).customer_id;
        } catch (error) {
            return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
        }

        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: 'Message content is required.' });
        }

        const ai = getAIClient();
        const model = getModelName();

        if (!ai) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not configured. Please add it to your .env file.' });
        }

        const [restaurantRows] = await db.query(
            `SELECT restaurant_id, name, status FROM restaurant WHERE status = 'open'`
        );

        const response = await ai.models.generateContent({
            model,
            contents: message,
            config: {
                systemInstruction: `You help customers book tables or join waitlists at Q-Sense restaurants.
                    Today's date context matters for resolving "tonight"/"tomorrow" — assume the user means
                    the near future, not a past date.
                    Open restaurants right now: ${restaurantRows.map((r) => r.name).join(', ') || 'none currently open'}.
                    If the user's message clearly requests booking a table or joining a queue, call the
                    matching function. If required details are missing (date, time, or party size), do NOT
                    call a function — ask a brief clarifying question in plain text instead.
                    If the message isn't a booking/queue request, respond normally in plain text.`,
                tools: [{ functionDeclarations: [bookTableDeclaration, joinQueueDeclaration] }],
                maxOutputTokens: 300,
                temperature: 0.1
            }
        });

        const functionCall = extractFunctionCall(response);

        if (!functionCall) {
            const reply = extractReplyText(response) || "Could you clarify what you'd like to do?";
            return res.json({ reply, action: null });
        }

        const args = functionCall.args || {};
        const restaurant = resolveRestaurantByName(args.restaurant_name, restaurantRows);

        if (!restaurant) {
            return res.json({
                reply: `I couldn't find an open restaurant matching "${args.restaurant_name || 'that name'}". Could you double-check the name?`,
                action: null
            });
        }

        if (functionCall.name === 'book_table') {
            const { group_size, reserve_date, reserve_time } = args;
            if (!group_size || !reserve_date || !reserve_time) {
                const missing = [!group_size && 'party size', !reserve_date && 'date', !reserve_time && 'time']
                    .filter(Boolean).join(', ');
                return res.json({ reply: `To book at ${restaurant.name}, I still need the ${missing}.`, action: null });
            }

            await db.query(
                `INSERT INTO reservation (customer_id, restaurant_id, group_size, reserve_date, reserve_time)
                 VALUES ($1, $2, $3, $4, $5)`,
                [customerId, restaurant.restaurant_id, group_size, reserve_date, reserve_time]
            );

            return res.json({
                reply: `Booked! A table for ${group_size} at ${restaurant.name} on ${reserve_date} at ${reserve_time}.`,
                action: { type: 'book_table', restaurant_id: restaurant.restaurant_id }
            });
        }

        if (functionCall.name === 'join_queue') {
            const { group_size } = args;
            if (!group_size) {
                return res.json({ reply: `How many people are in your party for ${restaurant.name}?`, action: null });
            }

            const [existing] = await db.query(
                `SELECT queue_id FROM queue WHERE customer_id = $1 AND restaurant_id = $2 AND status IN ('waiting', 'called')`,
                [customerId, restaurant.restaurant_id]
            );
            if (existing.length > 0) {
                return res.json({ reply: `You're already in the queue at ${restaurant.name}.`, action: null });
            }

            const [rows] = await db.query(
                `INSERT INTO queue (restaurant_id, customer_id, group_size) VALUES ($1, $2, $3) RETURNING queue_id`,
                [restaurant.restaurant_id, customerId, group_size]
            );

            return res.json({
                reply: `You're in! Joined the queue at ${restaurant.name} for ${group_size}.`,
                action: { type: 'join_queue', restaurant_id: restaurant.restaurant_id, queue_id: rows[0].queue_id }
            });
        }

        res.json({ reply: "I understood a request but couldn't complete it. Please try the Reservation or Join Queue page directly.", action: null });

    } catch (error) {
        console.error('Chatbot action error:', error);
        res.status(500).json({ error: 'Something went wrong processing that request.' });
    }
});

// ============================================================
// Natural-language search: Gemini parses free-text into REAL
// structured filters (only fields that actually exist in the
// schema — no "cuisine", that column doesn't exist). The actual
// filtering below is plain SQL/JS; Gemini only does the parsing.
// ============================================================

// ── POST /api/chatbots/search ────────────────────────────────────────
// Body: { query: "quiet place for 2 with a table free soon", lat, lng (optional) }
router.post('/search', async (req, res) => {
    const { query, lat, lng } = req.body;

    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'A search query is required.' });
    }

    const ai = getAIClient();
    const model = getModelName();

    if (!ai) {
        return res.status(500).json({ error: 'GEMINI_API_KEY is not configured.' });
    }

    try {
        const parsePrompt = `
            Extract search filters from this restaurant search request: "${query}"

            Respond with ONLY a JSON object, no other text, in exactly this shape:
            {
              "party_size": <integer or null — number of people, if mentioned>,
              "max_wait_minutes": <integer or null — max acceptable wait in minutes. "quick"/"no wait"/"fast" implies roughly 10-15>,
              "keyword": <string or null — a restaurant name or area to text-search for, if mentioned. Do not invent one>
            }
            If a field isn't mentioned or implied, use null for it. Include only these three fields.
        `;

        const response = await ai.models.generateContent({
            model,
            contents: parsePrompt,
            config: { responseMimeType: 'application/json', maxOutputTokens: 150, temperature: 0 }
        });

        const rawText = extractReplyText(response);
        let filters = {};
        try {
            filters = JSON.parse(rawText);
        } catch (parseError) {
            console.error('Could not parse Gemini search filters, raw text was:', rawText);
        }

        // Never trust the model's output shape blindly — validate/clamp
        // every field ourselves before using it in a query.
        const party_size = Number.isInteger(filters.party_size) ? filters.party_size : null;
        const max_wait_minutes = Number.isInteger(filters.max_wait_minutes) ? filters.max_wait_minutes : null;
        const keyword = typeof filters.keyword === 'string' && filters.keyword.trim() ? filters.keyword.trim() : null;

        const conditions = [`r.status = 'open'`];
        const params = [];
        if (keyword) {
            params.push(`%${keyword}%`);
            conditions.push(`(r.name ILIKE $${params.length} OR r.location ILIKE $${params.length})`);
        }

        const [rows] = await db.query(`
            SELECT r.restaurant_id, r.name, r.location, r.latitude, r.longitude,
                   COUNT(t.table_id) FILTER (WHERE t.status = 'vacant') AS vacant_tables,
                   COUNT(q.queue_id) FILTER (WHERE q.status = 'waiting') AS waiting_count
            FROM restaurant r
            LEFT JOIN restaurant_tables t ON t.restaurant_id = r.restaurant_id
            LEFT JOIN queue q ON q.restaurant_id = r.restaurant_id
            WHERE ${conditions.join(' AND ')}
            GROUP BY r.restaurant_id
            ORDER BY r.name ASC
        `, params);

        let results = rows.map((r) => ({ ...r, estimated_wait_min: (r.waiting_count || 0) * 5 }));

        if (party_size) {
            // We don't track free tables by exact capacity size per
            // party here, only "has at least one vacant table" — a
            // real capacity-aware match is a reasonable future add-on.
            results = results.filter((r) => r.vacant_tables > 0);
        }
        if (max_wait_minutes != null) {
            results = results.filter((r) => r.estimated_wait_min <= max_wait_minutes);
        }

        if (lat != null && lng != null) {
            results = rankByConvenience(parseFloat(lat), parseFloat(lng), results);
        }

        res.json({ filters: { party_size, max_wait_minutes, keyword }, results });

    } catch (error) {
        console.error('Search parsing error:', error.message);
        res.status(500).json({ error: 'Failed to process search.' });
    }
});

module.exports = router;
module.exports.isTopicRelevant = isTopicRelevant;

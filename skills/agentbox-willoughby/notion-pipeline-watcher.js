const fs = require('fs');
const { Client } = require('@notionhq/client');
require('dotenv').config({ path: '/root/.openclaw/.env', override: true });

const STATE_FILE = '/root/.openclaw/workspace/pipeline-state.json';

const WATCHED_STATUSES = [
    '🎯 To Call Today',
    '🗣️ Connected',
    '⏳ Left Message',
    '🤝 Appraisal Booked'
];

function loadState() {
    if (!fs.existsSync(STATE_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getContactName(page) {
    const titleProp = Object.values(page.properties).find(p => p.type === 'title');
    return titleProp?.title?.[0]?.plain_text?.trim() || page.id;
}

function getStatus(page) {
    const statusProp = Object.values(page.properties).find(p => p.type === 'status');
    return statusProp?.status?.name || null;
}

async function refreshAllDaysInStage(notion) {
    const state = loadState();
    const ids = Object.keys(state);
    console.log(`\nRefreshing Days in Stage for ${ids.length} pages...`);
    let refreshed = 0;
    let refreshErrors = 0;

    for (const id of ids) {
        const { lastSeen } = state[id];
        if (!lastSeen) continue;
        const days = Math.floor((Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24));
        try {
            await notion.pages.update({
                page_id: id,
                properties: {
                    'Days in Stage': { number: days }
                }
            });
            refreshed++;
        } catch (err) {
            console.error(`  ✗ Error refreshing days for ${id}: ${err.message}`);
            refreshErrors++;
        }
    }

    console.log(`Refresh done. ${refreshed} updated, ${refreshErrors} errors.`);
}

async function main() {
    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    const databaseId = process.env.NOTION_DATABASE_ID;

    const state = loadState();
    const newState = {};

    let allPages = [];
    let cursor = undefined;

    do {
        const res = await notion.databases.query({
            database_id: databaseId,
            start_cursor: cursor,
            page_size: 100
        });
        allPages = allPages.concat(res.results);
        cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    console.log(`Fetched ${allPages.length} pages from Notion.`);

    const now = new Date().toISOString();
    let written = 0;
    let errors = 0;

    for (const page of allPages) {
        const id = page.id;
        const currentStatus = getStatus(page);
        const name = getContactName(page);
        const previous = state[id];

        const isNew = !previous;
        const statusChanged = previous && previous.status !== currentStatus;

        const shouldWrite = currentStatus && WATCHED_STATUSES.includes(currentStatus) && (isNew || statusChanged);

        if (shouldWrite) {
            try {
                const daysInStage = Math.floor((Date.now() - new Date(now).getTime()) / (1000 * 60 * 60 * 24));
                await notion.pages.update({
                    page_id: id,
                    properties: {
                        'Stage Entered At': { date: { start: now } },
                        'Days in Stage': { number: daysInStage }
                    }
                });
                console.log(`  → [${name}] moved to ${currentStatus} — timestamp written (Days in Stage: ${daysInStage})`);
                written++;
            } catch (err) {
                console.error(`  ✗ Error updating [${name}]: ${err.message}`);
                errors++;
            }
        }

        newState[id] = {
            status: currentStatus,
            lastSeen: now
        };
    }

    saveState(newState);

    console.log(`\nDone. ${allPages.length} pages checked, ${written} timestamps written, ${errors} errors.`);

    // Refresh "Days in Stage" for every page tracked in state
    await refreshAllDaysInStage(notion);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});

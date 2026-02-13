import dotenv from 'dotenv';
dotenv.config();

import { Client, Events, GatewayIntentBits } from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import express from 'express';
import { Octokit } from "@octokit/rest";

const app = express();
const port = process.env.PORT || 3000;

// --- Discord Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
    ],
});

// --- Google GenAI ---
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- GitHub ---
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const REPO_OWNER = process.env.GITHUB_REPO.split("/")[0];
const REPO_NAME = process.env.GITHUB_REPO.split("/")[1];
const REPO_BRANCH = process.env.GITHUB_BRANCH || "main";

let leaderboard = {};

// --- GitHub helpers ---
async function publishLeaderboard(name) {
    const path = `leaderboards/${name}.json`;
    try {
        let sha;
        try {
            const file = await octokit.repos.getContent({ owner: REPO_OWNER, repo: REPO_NAME, path, ref: REPO_BRANCH });
            sha = file.data.sha;
        } catch(e) { }
        await octokit.repos.createOrUpdateFileContents({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path,
            message: `Publish leaderboard: ${name}`,
            content: Buffer.from(JSON.stringify(leaderboard, null, 2)).toString("base64"),
            branch: REPO_BRANCH,
            sha
        });
        return true;
    } catch(err) { console.error(err); return false; }
}

async function unpublishLeaderboard(name) {
    const path = `leaderboards/${name}.json`;
    try {
        const file = await octokit.repos.getContent({ owner: REPO_OWNER, repo: REPO_NAME, path, ref: REPO_BRANCH });
        await octokit.repos.deleteFile({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path,
            message: `Unpublish leaderboard: ${name}`,
            branch: REPO_BRANCH,
            sha: file.data.sha
        });
        return true;
    } catch(err) { console.error(err); return false; }
}

// --- Discord bot ---
async function init() {
    client.on(Events.MessageCreate, async message => {
        if (message.author.bot) return;

        const allowedGuildId = "1361375146941874458";
        const allowedRoleId = "1471376488002621460";

        if (message.guild?.id !== allowedGuildId) {
            await message.channel.send("This command can only be used in the designated server.");
            return;
        }

        // Make sure the member has the allowed role
        if (!message.member.roles.cache.has(allowedRoleId)) {
            await message.channel.send("You're not allowed to use this command.");
            return;
        }

        if (message.content.startsWith(`<@${client.user.id}>`)) {
            const messageText = message.content.replace(`<@${client.user.id}>`, '').trim() || '0';

            // Clear leaderboard
            if (messageText.toLowerCase() === 'clear') {
                leaderboard = {};
                await message.channel.send("Successfully cleared the leaderboard");
                return;
            }

            // Delete a game
            if (messageText.toLowerCase().startsWith('delete')) {
                const gameName = messageText.substring(6).trim();
                if (leaderboard[gameName]) {
                    delete leaderboard[gameName];
                    await message.channel.send(`Successfully deleted "${gameName}" from the leaderboard`);
                } else {
                    await message.channel.send(`Unable to find "${gameName}" in the leaderboard`);
                }
                return;
            }

            // Publish leaderboard
            if (messageText.toLowerCase().startsWith('publish')) {
                const lbName = messageText.substring(7).trim();
                if (!lbName) {
                    await message.channel.send(`Leaderboard name is required.`);
                    return;
                }
                const success = await publishLeaderboard(lbName);
                await message.channel.send(success ? `Successfully published "${lbName}" to GitHub.` : `Failed to publish "${lbName}".`);
                return;
            }

            // Unpublish leaderboard
            if (messageText.toLowerCase().startsWith('unpublish')) {
                const lbName = messageText.substring(9).trim();
                const success = await unpublishLeaderboard(lbName);
                await message.channel.send(success ? `Successfully unpublished "${lbName}" from GitHub.` : `Failed to unpublish "${lbName}".`);
                return;
            }

            if(message.attachments.size > 0)
            {
                const attachmentParts = await Promise.all(
                    message.attachments.map(async (attachment) => {
                        const response = await fetch(attachment.url);
                        const buffer = await response.arrayBuffer();
                        return {
                            inlineData: {
                                data: Buffer.from(buffer).toString("base64"),
                                mimeType: attachment.contentType
                            }
                        };
                    })
                );

                const prompt = `
                    class Team:
                    team_name: string - The exact name of the team.
                    placement: number - The rank/placement of the team in this game (1 for 1st, etc).
                    placement_points: number - Points awarded based on placement (1st=10, 2nd=8, 3rd=6, 4th=4, 5th=2, 6th-8th=0).
                    kills: number - Total kills (K.O.) confirmed for the team.
                    kill_points: number - 1 point per kill.
                    damage_dealt: number - Total damage dealt by the team.
                    damage_points: number - 1 point for every 1000 damage dealt (integer division).
                    total_points: number - Sum of placement, kill, and damage points.
                    players: array of Player objects, where each Player has:
                        name: string - The exact name of the player.
                        kills: number - Total kills from player
                        damage_dealt: number - Total damage dealt by the player.

                    You are an Esports Tournament Scorer.

                    Attached are screenshots of the game results for a game.

                    YOUR TASK:
                        
                    Identify the players in the screenshots.
                    Extract their Placement, Kills (K.O.), and Total Damage.
                    Calculate points based on this system:
                    
                    Placement Points: 1st=10, 2nd=8, 3rd=6, 4th=4, 5th=2, 6th-8th=0.
                    Kill Points: 1 pt per Kill.
                    Damage Points: 1 pt per 1000 Damage (floor division).

                    JSON to return:
                    An array of objects, one per team
                    Return a strictly formatted JSON`;

                const contents = [ prompt, ...attachmentParts ];
                try{
                    const result = await genAI.models.generateContent({
                        model: 'gemini-3-flash-preview',
                        contents: contents
                    });
                    
                    const rawText = result.candidates[0].content.parts[0].text;
                    const cleanJson = rawText.replace(/```json|```/g, "").trim();
                    leaderboard[messageText] = JSON.parse(cleanJson);
                    await message.channel.send(`Successfully added "${messageText}" to the leaderboard.`);
                }
                catch(error)
                {
                    console.error(error);
                    await message.channel.send(`An error occurred`);
                }
            }
        }
    });

    await client.login(process.env.DISCORD_TOKEN);
}

await init();

// --- Leaderboard HTML rendering ---
function renderLeaderboardHTML(data, title="Tournament Standings") {
    const statsByTeam = Object.entries(data).reduce((acc, [gameName, teams]) => {
        teams.forEach(team => {
            const tName = team.team_name.toUpperCase();
            if (!acc[tName]) acc[tName] = { team_name: tName, total_points: 0, total_kills: 0, total_damage: 0, games: [], players: {} };
            acc[tName].total_points += team.total_points;
            acc[tName].total_kills += team.kills;
            acc[tName].total_damage += team.damage_dealt;
            acc[tName].games.push({ gameName, ...team });

            team.players.forEach(player => {
                if(!acc[tName].players[player.name]) acc[tName].players[player.name] = { name: player.name, total_kills: 0, total_damage: 0 };
                acc[tName].players[player.name].total_kills += player.kills;
                acc[tName].players[player.name].total_damage += player.damage_dealt;
            });
        });
        return acc;
    }, {});

    const sortedLeaderboard = Object.values(statsByTeam).sort((a,b) => b.total_points - a.total_points);

    const rows = sortedLeaderboard.map((team, index) => {
        const gameRows = team.games.map(g => {
            const perGamePlayersRows = g.players.map(p => `
                <tr>
                    <td>${p.name}</td>
                    <td>${p.kills}</td>
                    <td>${p.damage_dealt.toLocaleString()}</td>
                </tr>`).join('');

            return `
            <table class="nested-table">
                <thead>
                    <tr>
                        <th colspan="4">${g.gameName} - Placement: ${g.placement}</th>
                    </tr>
                    <tr>
                        <th>Team Kills</th>
                        <th>Team Damage</th>
                        <th>Points</th>
                        <th>Players</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>${g.kills}</td>
                        <td>${g.damage_dealt.toLocaleString()}</td>
                        <td>${g.total_points}</td>
                        <td>
                            <table class="nested-inner-table">
                                <thead>
                                    <tr>
                                        <th>Player</th>
                                        <th>Kills</th>
                                        <th>Damage</th>
                                    </tr>
                                </thead>
                                <tbody>${perGamePlayersRows}</tbody>
                            </table>
                        </td>
                    </tr>
                </tbody>
            </table>`;
        }).join('');

        const overallPlayerRows = Object.values(team.players)
            .sort((a,b)=>b.total_kills-a.total_kills)
            .map(p => `
                <tr>
                    <td>${p.name}</td>
                    <td>${p.total_kills}</td>
                    <td>${p.total_damage.toLocaleString()}</td>
                </tr>`).join('');

        return `
        <tr class="main-row" onclick="toggleDetails('details-${index}')">
            <td>${index+1}</td>
            <td><strong>${team.team_name}</strong></td>
            <td>${team.total_kills}</td>
            <td>${team.total_damage.toLocaleString()}</td>
            <td class="points">${team.total_points}</td>
        </tr>
        <tr id="details-${index}" class="details-row" style="display:none;">
            <td colspan="5">
                <div class="expansion-content">
                    <table class="nested-table">
                        <thead>
                            <tr>
                                <th>Player</th>
                                <th>Total Kills</th>
                                <th>Total Damage</th>
                            </tr>
                        </thead>
                        <tbody>${overallPlayerRows}</tbody>
                    </table>
                    ${gameRows}
                </div>
            </td>
        </tr>
        `;
    }).join('');

    return `
    <!DOCTYPE html>
    <html>
    <head>
    <title>${title}</title>
    <style>
    body{font-family:'Segoe UI',sans-serif;background:#121212;color:#e0e0e0;padding:40px;}
    table{width:100%;max-width:1000px;margin:auto;border-collapse:collapse;background:#1e1e1e;box-shadow:0 10px 30px rgba(0,0,0,0.5);border-radius:8px;}
    th{background:#2d2d2d;color:#00ffa3;text-transform:uppercase;font-size:13px;}
    th,td{padding:14px;border-bottom:1px solid #333;text-align:center;}
    .main-row{cursor:pointer;transition:.2s ease;}
    .main-row:hover{background:#2a2a2a;}
    .points{color:#00ffa3;font-weight:bold;text-align:right;}
    .details-row{background:#161616;}
    .expansion-content{padding:20px;}
    .nested-table{width:100%;border-collapse:collapse;margin-bottom:5px;background:#1c1c1c;}
    .nested-table th, .nested-table td{padding:8px;border:1px solid #333;font-size:13px;text-align:center;}
    .nested-inner-table th, .nested-inner-table td{padding:6px;border:1px solid #222;font-size:12px;text-align:center;}
    h2{text-align:center;margin-bottom:5px;}
    h4{margin-bottom:5px;color:#00ffa3;}
    </style>
    <script>
    function toggleDetails(id){const el=document.getElementById(id);el.style.display=el.style.display==='none'?'table-row':'none';}
    </script>
    </head>
    <body>
    <h2>🏆 ${title}</h2>
    <table>
        <thead>
            <tr>
                <th>Rank</th>
                <th>Team Name</th>
                <th>Total Kills</th>
                <th>Total Damage</th>
                <th style="text-align:right;">Total Points</th>
            </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="5" style="text-align:center">No matches recorded yet.</td></tr>'}</tbody>
    </table>
    </body>
    </html>
    `;
}


// --- Express routes ---
app.get("/", (req,res) => res.send(renderLeaderboardHTML(leaderboard)));

app.get("/:name", async (req,res) => {
    const name = req.params.name;
    let data = leaderboard[name];

    if(!data) {
        try {
            const file = await octokit.repos.getContent({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                path: `leaderboards/${name}.json`,
                ref: REPO_BRANCH
            });
            const content = Buffer.from(file.data.content,'base64').toString('utf-8');
            data = JSON.parse(content);
            leaderboard = data;
        } catch(err) { return res.status(404).send(`Leaderboard "${name}" not found.`); }
    }
    res.send(renderLeaderboardHTML(leaderboard));
});

// --- Start server ---
app.listen(port, () => console.log(`Access the leaderboard at http://localhost:${port}/`));

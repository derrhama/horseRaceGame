// --- 1. Import Libraries ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { google } = require('googleapis');
const fs = require('fs');

// --- 2. Setup Server ---
const app = express();
const server = http.createServer(app);
const io = new socketIo.Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'start'; 

// --- 3. "Database" (For Now) ---
let players = {}; 
let horseProgress = []; 
let gameState = 'LOBBY'; 
let serverFinishOrder = [];
let hostSocketId = null; 

let allQuestions = {
	1: [],
	2: [],
	3: []
};

// --- *** Google Sheets Integration *** ---
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const SPREADSHEET_ID = "1dxLNnJNRJQ5ZBkuySjHFP7zB_epOrD5He5YUt-AdUtA";
let credentials;
try {
	const credentialsPath = '/etc/secrets/credentials.json';
	const credentialsFile = fs.readFileSync(credentialsPath, 'utf8'); 
	credentials = JSON.parse(credentialsFile);
} catch (e) {
	console.error("CRITICAL ERROR: Could not read or parse /etc/secrets/credentials.json.", e.message);
	process.exit(1);
}

async function getAuthClient() {
	const auth = new google.auth.JWT({
		email: credentials.client_email,
		key: credentials.private_key,
		scopes: SCOPES
	});
	await auth.authorize();
	return auth;
}


/**
 * --- *** NEW UNIVERSAL PARSER (V5) *** ---
 * This version correctly parses [type:...] AND [type|...]
 */
function parseQuestionString(str) {
	try {
		// 1. Find the [type...] part, stop at the first ]
		const match = str.match(/\[(.*?)\]/);
		if (!match) return null;

		const content = match[1];
		
		// 2. Find the *first* separator (':' or '|')
		let separatorIndex = content.indexOf(':');
		if (separatorIndex === -1) {
			separatorIndex = content.indexOf('|');
		}
		if (separatorIndex === -1) return null; // No separator found
		
		// 3. Extract type and the rest of the content
		const type = content.substring(0, separatorIndex).trim().toLowerCase();
		const questionAndOptions = content.substring(separatorIndex + 1);
		
		// 4. Parse the remaining parts
		const parts = questionAndOptions.split('|').map(p => p.trim());
		if (parts.length < 2) return null; // [question|feedback] is minimum

		const questionText = parts[0];
		const feedback = parts[parts.length - 1];
		const items = parts.slice(1, parts.length - 1); // All middle parts

		if (type === 'mcq') {
			let choices = [];
			let correctAnswer = '';
			items.forEach(item => {
				if (item.endsWith('*')) {
					correctAnswer = item.substring(0, item.length - 1);
					choices.push(correctAnswer);
				} else {
					choices.push(item);
				}
			});
			if (!correctAnswer) return null;
			return { type, q: questionText, choices, a: correctAnswer, feedback };

		} else if (type === 'msq') {
			let choices = [];
			let correctAnswers = [];
			items.forEach(item => {
				if (item.endsWith('*')) {
					const clean = item.substring(0, item.length - 1);
					correctAnswers.push(clean);
					choices.push(clean);
				} else {
					choices.push(item);
				}
			});
			if (correctAnswers.length === 0) return null;
			return { type, q: questionText, choices, a: correctAnswers.sort().join(','), feedback };

		} else if (type === 'text') {
			if (items.length !== 1 || !items[0].endsWith('*')) return null;
			return { type, q: questionText, choices: null, a: items[0].substring(0, items[0].length - 1), feedback };

		} else if (type === 'rank') {
			// [rank:Q|Item1|Item2|Item3|Feedback]
			// Answer is "Item1,Item2,Item3"
			return {
				type,
				q: questionText,
				choices: items, // The items to be ranked
				a: items.join(','), // The correct order is the written order
				feedback
			};
		} else if (type === 'match') {
			// [match:Q|Stem1|Target1|Stem2|Target2|Feedback]
			if (items.length === 0 || items.length % 2 !== 0) return null; // Must be pairs
			let stems = [];
			let options = [];
			let answerPairs = [];
			for (let i = 0; i < items.length; i += 2) {
				stems.push(items[i]);
				options.push(items[i + 1]);
				answerPairs.push(`${items[i]}-${items[i + 1]}`);
			}
			return {
				type,
				q: questionText,
				stems: stems, // The static list
				choices: options, // The list to be dragged
				a: answerPairs.sort().join(','), // "Stem1-Target1,Stem2-Target2"
				feedback
			};
		} else if (type === 'sort') {
			// [sort:Q|Bucket1|Bucket2|ItemA (1)|ItemB (2)|Feedback]
			const itemRegex = /(.*?) \((\d+)\)$/;
			let buckets = [];
			let choices = [];
			let answerPairs = [];

			items.forEach(item => {
				const match = item.match(itemRegex);
				if (match) {
					// It's an item, e.g., "Apple (1)"
					const itemName = match[1].trim();
					const bucketIndex = match[2];
					choices.push(itemName);
					answerPairs.push(`${itemName}-${bucketIndex}`);
				} else {
					// It's a bucket name, e.g., "Fruits"
					buckets.push(item);
				}
			});
			if (buckets.length === 0 || choices.length === 0) return null;
			return {
				type,
				q: questionText,
				buckets: buckets, // ["Fruits", "Vegetables"]
				choices: choices, // ["Apple", "Carrot", "Banana"]
				a: answerPairs.sort().join(','), // "Apple-1,Banana-1,Carrot-2"
				feedback
			};
		}
		
		return null; // Unknown type

	} catch (e) {
		console.error("Error parsing question string:", str, e);
		return null;
	}
}
// --- *** END OF NEW PARSER *** ---


/**
 * Fetches and parses all questions from your sheet
 */
async function loadQuestionsFromSheet(auth) {
	const sheets = google.sheets({ version: 'v4', auth });
	
	if (!SPREADSHEET_ID) {
		throw new Error("SPREADSHEET_ID is not set.");
	}
	
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SPREADSHEET_ID,
		range: 'Questions!A2:B', 
	});

	const rows = res.data.values;
	if (!rows || rows.length === 0) {
		console.error("No questions found in Google Sheet.");
		return;
	}

	allQuestions = { 1: [], 2: [], 3: [] };
	let count = 0;

	for (const row of rows) {
		const difficulty = row[0];
		const qString = row[1];

		if (difficulty && qString && allQuestions[difficulty]) {
			const parsedQ = parseQuestionString(qString);
			
			if (parsedQ) {
				let steps, danger, penalty;
				if (difficulty === '1') { [steps, danger, penalty] = [1, 5000, 5000]; }
				else if (difficulty === '2') { [steps, danger, penalty] = [2, 10000, 10000]; }
				else { [steps, danger, penalty] = [3, 15000, 15000]; }

				allQuestions[difficulty].push({
					...parsedQ,
					d: { steps, danger, penalty }
				});
				count++;
			} else {
				console.warn(`Could not parse question: ${qString}`);
			}
		}
	}
	console.log(`Successfully loaded ${count} questions from Google Sheets.`);
}
// --- *** END of Google Sheets Integration *** ---


// --- 4. Serve Your HTML File ---
app.use(express.static(__dirname));

function syncGameForSocket(socket) {
	socket.emit('syncGame', {
		allPlayers: players,
		allProgress: horseProgress,
		currentState: gameState,
		isHost: (socket.id === hostSocketId),
		myId: socket.id 
	});
}

// --- 5. Handle Real-Time Connections ---
io.on('connection', (socket) => {
	
	// --- PLAYER JOIN LOGIC (Player only) ---
	socket.on('joinGame', (data) => {
		if (gameState !== 'LOBBY') {
			socket.emit('gameInProgress');
			return;
		}

		let lane = 0;
		const usedLanes = Object.values(players).map(p => p.lane);
		while (usedLanes.includes(lane)) {
			lane++;
		}
		
		const newPlayer = {
			id: socket.id,
			name: data.name,
			color: data.color,
			lane: lane,
			passes: 3,
			state: 'idle', 
			currentQuestion: null,
			questionStartTime: 0 
		};

		players[socket.id] = newPlayer;
		horseProgress[lane] = 0;

		syncGameForSocket(socket); 
		socket.broadcast.emit('playerJoined', newPlayer); 

		console.log(`Player ${newPlayer.name} joined in lane ${lane}`);
	});

	// --- HOST LOGIN LOGIC ---
	socket.on('hostLogin', (data) => {
		if (data.adminPass === ADMIN_PASSWORD) {
			hostSocketId = socket.id;
			console.log("A HOST has connected.");
			syncGameForSocket(socket); 
		}
	});


	// --- START RACE EVENT ---
	socket.on('startRace', () => {
		if (socket.id === hostSocketId && gameState === 'LOBBY') {
			console.log("--- RACE STARTING IN 5 SECONDS ---");
			io.emit('raceStarting');
			
			setTimeout(() => {
				if (gameState === 'LOBBY') { 
					gameState = 'RACING';
					serverFinishOrder = []; 
					io.emit('gameStateChange', gameState);
					console.log("--- RACE STARTED (GO!) ---");
				}
			}, 5000); 
		}
	});

	// --- RESET GAME EVENT ---
	socket.on('resetGame', () => {
		if (socket.id === hostSocketId && (gameState === 'FINISHED' || gameState === 'LOBBY')) { 
			console.log("--- HOST IS RESETTING GAME ---");
			getAuthClient().then(auth => {
				loadQuestionsFromSheet(auth);
			}).catch(e => {
				console.error("Could not reload questions:", e);
			});
			
			players = {};
			horseProgress = [];
			gameState = 'LOBBY';
			serverFinishOrder = [];
			io.emit('gameReset');
		}
	});

	// --- "MASTER PLAN" LOGIC ---
	socket.on('requestQuestion', (data) => {
		const player = players[socket.id];
		if (gameState !== 'RACING' || !player || player.state !== 'idle') {
			return; 
		}
		
		player.state = 'answering';
		const difficulty = data.difficulty;
		
		const qBank = allQuestions[difficulty];
		if (!qBank || qBank.length === 0) {
			console.error(`No questions found for difficulty ${difficulty}`);
			player.state = 'idle';
			socket.emit('error', 'No questions available for that difficulty.');
			return;
		}
		
		const question = qBank[Math.floor(Math.random() * qBank.length)];
		
		player.currentQuestion = question; 
		player.questionStartTime = Date.now(); 
		
		// Send all new data
		socket.emit('hereIsYourQuestion', {
			type: question.type,
			question: question.q,
			choices: question.choices, // For mcq, msq, rank, sort
			stems: question.stems,     // For match
			buckets: question.buckets, // For sort
			dangerZone: question.d.danger 
		});
	});

	socket.on('submitAnswer', (data) => {
		const player = players[socket.id];
		if (gameState !== 'RACING' || !player || player.state !== 'answering') return; 

		const question = player.currentQuestion;
		const startTime = player.questionStartTime;
		player.currentQuestion = null;
		player.questionStartTime = 0;
		if (!question) return; 

		let submittedAnswer = (data.answer || "").toLowerCase().trim();
		let correctAnswer = (question.a || "").toLowerCase().trim();
		
		// --- UPDATED: Sorting for MSQ, Match, Sort ---
		if (question.type === 'msq' || question.type === 'sort' || question.type === 'match') {
			submittedAnswer = submittedAnswer.split(',')
											 .map(s => s.trim())
											 .sort()
											 .join(',');
		}
		// --- End Check ---
		
		if (submittedAnswer === correctAnswer) {
			// --- CORRECT ---
			player.state = 'idle'; 
			const steps = question.d.steps;
			const currentPosition = horseProgress[player.lane] || 0;
			const newPosition = currentPosition + (steps * 35);
			horseProgress[player.lane] = newPosition;
			
			io.emit('horseAdvanced', {
				lane: player.lane,
				newPosition: newPosition
			});
			
			if (newPosition >= 700 && !serverFinishOrder.includes(player.lane)) { 
				serverFinishOrder.push(player.lane);
				let place = serverFinishOrder.length;

				socket.emit('youFinished', { place: place });
				
				if (place === 1) { 
					socket.broadcast.emit('winnerAnnounced', player.name); 
				}

				if (serverFinishOrder.length === Object.keys(players).length) {
					gameState = 'FINISHED';
					const winnerLane = serverFinishOrder[0];
					const winner = Object.values(players).find(p => p.lane === winnerLane);
					io.emit('gameStateChange', gameState, winner ? winner.name : 'The winner'); 
					console.log("--- RACE FINISHED (All players) ---");
				}
				
				return;
			}
			
			socket.emit('answerResult', { correct: true, feedback: question.feedback });
			
		} else {
			// --- INCORRECT ---
			const dangerDuration = question.d.danger;
			const timeElapsed = Date.now() - startTime;

			if (timeElapsed < dangerDuration) {
				// --- PENALIZED ---
				player.state = 'penalized';
				const penaltyDuration = question.d.penalty;

				socket.emit('answerResult', { 
					correct: false, 
					penalized: true,
					penalty: penaltyDuration,
					feedback: question.feedback
				});
				
				setTimeout(() => {
					if (players[socket.id]) {
						players[socket.id].state = 'idle';
						socket.emit('penaltyOver'); 
					}
				}, penaltyDuration);

			} else {
				// --- JUST WRONG (Safe) ---
				player.state = 'idle';
				socket.emit('answerResult', { 
					correct: false, 
					penalized: false,
					feedback: question.feedback
				});
			}
		}
	});
	
	// --- *** UPDATED: PASS BUG FIX *** ---
	socket.on('passQuestion', (data) => {
		const player = players[socket.id];
		if (gameState !== 'RACING' || !player || player.state !== 'answering') return;
		
		if (player.passes > 0) {
			// --- SUCCESSFUL PASS ---
			player.passes--;
			player.state = 'idle';
			player.currentQuestion = null; 
			player.questionStartTime = 0;
			socket.emit('passUsed', { 
				success: true, 
				passesRemaining: player.passes 
			});
		} else {
			// --- FAILED PASS (Bug Fix) ---
			socket.emit('passUsed', { 
				success: false,
				passesRemaining: 0
			});
		}
	});

	// --- DISCONNECT LOGIC ---
	socket.on('disconnect', () => {
		if (socket.id === hostSocketId) {
			hostSocketId = null;
			console.log("--- HOST disconnected ---");
		}
		
		const player = players[socket.id];
		if (player) {
			console.log(`Player ${player.name} disconnected.`);
			
			if (gameState === 'RACING' && !serverFinishOrder.includes(player.lane)) {
				serverFinishOrder.push(player.lane); 
				console.log(`Adding ${player.name} to finish order as DNF.`);
				 if (serverFinishOrder.length === Object.keys(players).length -1) { 
					gameState = 'FINISHED';
					const winnerLane = serverFinishOrder[0];
					const winner = Object.values(players).find(p => p.lane === winnerLane);
					io.emit('gameStateChange', gameState, winner ? winner.name : 'The winner'); 
					console.log("--- RACE FINISHED (Last player DNF) ---");
				}
			}
			delete players[socket.id];
			io.emit('playerLeft', { lane: player.lane, name: player.name });
		}
		
		if (Object.keys(players).length === 0 && !hostSocketId) {
			console.log("Everyone left. Resetting to LOBBY.");
			gameState = 'LOBBY';
		}
	});
});
// --- *** END OF FILE *** ---

// --- 6. Start the Server ---
async function startServer() {
	try {
		if (!credentials || !credentials.client_email || !credentials.private_key) {
			throw new Error("Credentials object is missing client_email or private_key.");
		}
		if (!SPREADSHEET_ID) {
			throw new Error("SPREADSHEET_ID is not set.");
		}
		
		const auth = await getAuthClient();
		await loadQuestionsFromSheet(auth);
		
		server.listen(PORT, () => {
			console.log(`Server running on http://localhost:${PORT}`);
		});
	} catch (e) {
		console.error("Failed to start server:", e.message);
		process.exit(1);
	}
}

startServer();
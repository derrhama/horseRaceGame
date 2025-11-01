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
 * --- *** NEW UNIVERSAL PARSER *** ---
 * Handles mcq, msq, text, rank, sort, and match
 */
function parseQuestionString(str) {
	try {
		const startIndex = str.indexOf('[');
		const endIndex = str.indexOf(']');
		
		if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
			return null; 
		}

		const content = str.substring(startIndex + 1, endIndex);
		const parts = content.split('|').map(p => p.trim()); // Trim whitespace
		
		if (parts.length < 3) return null; // [type|question|feedback] is minimum

		const type = parts[0].toLowerCase();
		const questionText = parts[1];
		const feedback = parts[parts.length - 1];
		
		// Get all parts between question and feedback
		const allOptions = parts.slice(2, parts.length - 1);
		
		let correctAnswers = [];
		let choices = [];

		allOptions.forEach(option => {
			if (option.endsWith('*')) {
				const cleanAnswer = option.substring(0, option.length - 1);
				correctAnswers.push(cleanAnswer);
				// For mcq/msq, add the clean version to choices
				if (type === 'mcq' || type === 'msq') {
					choices.push(cleanAnswer);
				}
			} else {
				// If not an answer, it's just a choice (for mcq/msq)
				if (type === 'mcq' || type === 'msq') {
					choices.push(option);
				}
			}
		});

		// Final processing
		if (type === 'mcq') {
			if (correctAnswers.length !== 1) return null; // MCQ must have exactly one answer
			return {
				q: questionText,
				choices: choices,
				a: correctAnswers[0], // Single answer
				feedback: feedback,
				type: type
			};
		} else if (type === 'msq') {
			if (correctAnswers.length === 0) return null; // MSQ must have at least one answer
			return {
				q: questionText,
				choices: choices,
				a: correctAnswers.sort().join(','), // Comma-separated, sorted
				feedback: feedback,
				type: type
			};
		} else if (['text', 'rank', 'sort', 'match'].includes(type)) {
			if (correctAnswers.length !== 1) return null; // These types must have one answer
			return {
				q: questionText,
				choices: null, // Will render as text box
				a: correctAnswers[0],
				feedback: feedback,
				type: type
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
	// ... (rest of the file is identical) ...
	
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
		
		socket.emit('hereIsYourQuestion', {
			question: question.q,
			choices: question.choices, 
			type: question.type,     
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

		// --- UPDATED: Answer checking for MSQ ---
		let submittedAnswer = (data.answer || "").toLowerCase().trim();
		let correctAnswer = (question.a || "").toLowerCase().trim();
		
		// Special check for MSQ: sort answers to match
		if (question.type === 'msq') {
			submittedAnswer = submittedAnswer.split(',')
											 .map(s => s.trim())
											 .sort()
											 .join(',');
		}
		// --- End MSQ Check ---
		
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
			// --- *** BUG FIX *** ---
			// Do NOT change state. Do NOT clear question.
			// Just tell them they are out of passes.
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
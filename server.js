// --- 1. Import Libraries ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
// --- NEW: Google Sheets API ---
const { google } = require('googleapis');
const credentials = require('/etc/secrets/credentials.json');

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
// *** PUT YOUR SPREADSHEET ID HERE ***
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_GOES_HERE'; 

async function getAuthClient() {
	const auth = new google.auth.JWT(
		credentials.client_email,
		null,
		credentials.private_key,
		SCOPES
	);
	await auth.authorize();
	return auth;
}

/**
 * --- *** UPDATED PARSER *** ---
 * This is now more robust and correctly handles your "[...]|||" format.
 */
function parseQuestionString(str) {
	try {
		// 1. Find the first '[' and first ']'
		const startIndex = str.indexOf('[');
		const endIndex = str.indexOf(']');
		
		if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
			return null; // Brackets not found or in wrong order
		}

		// 2. Extract the content *between* the brackets
		const content = str.substring(startIndex + 1, endIndex);
		
		// 3. Split by |
		const parts = content.split('|');
		if (parts.length < 4) return null; // [type|question|answer1*|feedback]

		const type = parts[0];
		const questionText = parts[1];
		const feedback = parts[parts.length - 1];
		
		if (type === 'mcq') {
			const choices = parts.slice(2, parts.length - 1);
			let correctAnswer = '';
			
			const processedChoices = choices.map(choice => {
				if (choice.endsWith('*')) {
					const cleanChoice = choice.substring(0, choice.length - 1);
					correctAnswer = cleanChoice;
					return cleanChoice;
				}
				return choice;
			});

			if (correctAnswer) {
				return {
					q: questionText,
					choices: processedChoices,
					a: correctAnswer,
					feedback: feedback,
					type: type
				};
			}
		}
		
		return null; 

	} catch (e) {
		console.error("Error parsing question string:", str, e);
		return null;
	}
}

/**
 * Fetches and parses all questions from your sheet
 */
async function loadQuestionsFromSheet(auth) {
	const sheets = google.sheets({ version: 'v4', auth });
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
	console.log(`A user connected: ${socket.id}`);

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

		let submittedAnswer = (data.answer || "").toLowerCase().trim();
		let correctAnswer = (question.a || "").toLowerCase().trim();
		
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
			player.passes--;
			player.state = 'idle';
			player.currentQuestion = null; 
			player.questionStartTime = 0;
			socket.emit('passUsed', { 
				success: true, 
				passesRemaining: player.passes 
			});
		} else {
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
		const auth = await getAuthClient();
		await loadQuestionsFromSheet(auth);
		
		server.listen(PORT, () => {
			console.log(`Server running on http://localhost:${PORT}`);
		});
	} catch (e) {
		console.error("Failed to authenticate with Google Sheets:", e);
		process.exit(1);
	}
}

startServer();
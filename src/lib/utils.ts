import PocketBase from 'pocketbase-sveltekit';
import { access } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import spawn from 'cross-spawn';
import path from 'path';
import net from 'net';
import { detect } from 'package-manager-detector/detect';
import { resolveCommand } from 'package-manager-detector/commands';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.js';

export type Config = {
	pocketbaseUrl: string;
	superuserEmail: string;
	superuserPassword: string;
	root?: string;
};

export function debounce<T extends (...args: any[]) => any>(
	func: T,
	wait: number
): (...args: Parameters<T>) => void {
	let timeout: NodeJS.Timeout;
	return (...args: Parameters<T>) => {
		clearTimeout(timeout);
		timeout = setTimeout(() => func(...args), wait);
	};
}

export async function fileExists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export function randomPort() {
	return Math.floor(Math.random() * 10000) + 10000;
}

function waitForPort(port: number, host: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const maxAttempts = 10;
		let attempts = 0;

		const tryConnect = () => {
			attempts++;

			const socket = new net.Socket();

			const onError = () => {
				socket.destroy();

				if (attempts === maxAttempts) {
					reject(new Error(`Timed out waiting for port ${port} to be available`));
					return;
				}

				setTimeout(tryConnect, 500);
			};

			socket.once('error', onError);

			socket.connect(port, host, () => {
				socket.destroy();
				resolve();
			});
		};

		tryConnect();
	});
}

export function waitForHealth(url: string, maxAttempts = 10): Promise<void> {
	return new Promise((resolve, reject) => {
		let attempts = 0;

		const tryHealth = async () => {
			attempts++;

			try {
				const response = await fetch(`${url}/api/health`);
				if (response.status === 200) {
					resolve();
					return;
				}
			} catch {
				// Ignore fetch errors and continue retrying
			}

			if (attempts === maxAttempts) {
				reject(new Error(`Timed out waiting for health check at ${url}/api/health`));
				return;
			}

			setTimeout(tryHealth, 500);
		};

		tryHealth();
	});
}

// TODO: handle auth here instead of in the caller
export async function withPocketbase(cwd: string, fn: (pb: PocketBase) => Promise<void>) {
	const dir = path.join(cwd, DATA_DIR);
	const migrationsDir = path.join(cwd, MIGRATIONS_DIR);
	const host = 'localhost';

	if (!existsSync(dir)) {
		throw new Error('PocketBase data directory does not exist');
	}

	// First check if the server is already running by reading node_modules/.vite/_pocketbase_metadata.json
	const metadataPath = path.join(cwd, 'node_modules', '.vite', '_pocketbase_metadata.json');
	if (existsSync(metadataPath)) {
		const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
		if (metadata.pocketbaseUrl) {
			const pb = new PocketBase(metadata.pocketbaseUrl);
			await authWithRetries(
				pb,
				process.env.POCKETBASE_SUPERUSER_EMAIL!,
				process.env.POCKETBASE_SUPERUSER_PASSWORD!
			);
			await fn(pb);
			return;
		}
	}

	const port = randomPort();
	const commandArgs = [
		'pocketbase-server',
		'serve',
		'--dir',
		dir,
		'--migrationsDir',
		migrationsDir,
		'--http',
		`${host}:${port}`
	];

	const packageManager = (await detect({ cwd }))?.name ?? 'npm';
	const { command, args } = resolveCommand(packageManager, 'execute', commandArgs)!;

	// adding --yes as the first parameter helps avoiding the "Need to install the following packages:" message
	if (packageManager === 'npm') args.unshift('--yes');

	// Start the PocketBase server process
	const serverProcess = spawn(command, args, {
		stdio: 'ignore'
	});

	try {
		// Wait for the server to be ready
		await waitForPort(port, host);
		await waitForHealth(`http://${host}:${port}`);

		const pb = new PocketBase(`http://${host}:${port}`);
		await authWithRetries(
			pb,
			process.env.POCKETBASE_SUPERUSER_EMAIL!,
			process.env.POCKETBASE_SUPERUSER_PASSWORD!
		);
		await fn(pb);
	} finally {
		// Ensure we always clean up the process
		serverProcess.kill();
	}
}

async function authWithRetries(pb: PocketBase, email: string, password: string) {
	// Retry authentication up to 3 times with 100ms backoff
	let authSuccess = false;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await pb.collection('_superusers').authWithPassword(email, password);
			authSuccess = true;
			break;
		} catch {
			if (attempt < 3) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	}

	if (!authSuccess) {
		throw new Error('Failed to authenticate with PocketBase. Check your superuser credentials.');
	}
}

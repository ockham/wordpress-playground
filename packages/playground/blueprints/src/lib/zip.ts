/**
 * @TODO: Errors thrown inside streams are ignored
 */

import { Semaphore } from '@php-wasm/util';

const CENTRAL_DIRECTORY_END_SCAN_CHUNK_SIZE = 50 * 1024;

const FILE_HEADER_SIZE = 32;
const SIGNATURE_FILE = 0x04034b50 as const;
const SIGNATURE_CENTRAL_DIRECTORY_START = 0x02014b50 as const;
const SIGNATURE_CENTRAL_DIRECTORY_END = 0x06054b50 as const;

function zipEntries(stream: ReadableStream<Uint8Array>) {
	return new ReadableStream<ZipEntry>({
		async pull(controller) {
			try {
				const entry = await readNextEntry(stream);
				if (!entry) {
					controller.close();
					return;
				}
				controller.enqueue(entry);
			} catch (e) {
				console.error(e);
				controller.error(e);
				throw e;
			}
		},
	});
}

async function readNextEntry(stream: ReadableStream<Uint8Array>) {
	const sigData = new DataView((await readBytes(stream, 4))!.buffer);
	const signature = sigData.getUint32(0, true);
	if (signature === SIGNATURE_FILE) {
		return await readFileEntry(stream, true);
	} else if (signature === SIGNATURE_CENTRAL_DIRECTORY_START) {
		return await readCentralDirectory(stream, true);
	} else if (signature === SIGNATURE_CENTRAL_DIRECTORY_END) {
		return await readEndCentralDirectory(stream, true);
	}
	return null;
}

export type ZipEntry =
	| FileEntry
	| CentralDirectoryEntry
	| CentralDirectoryEndEntry;

export interface FileEntry {
	signature: typeof SIGNATURE_FILE;
	startsAt?: number;
	extract?: any;
	version: number;
	generalPurpose: number;
	compressionMethod: number;
	lastModifiedTime: number;
	lastModifiedDate: number;
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	fileNameLength: number;
	fileName: string;
	isDirectory: boolean;
	extraLength: number;
	extra: Uint8Array;
	text(): Promise<string>;
	bytes(): Promise<Uint8Array>;
}

async function readFileEntry(
	stream: ReadableStream<Uint8Array>,
	skipSignature = false
): Promise<FileEntry | null> {
	if (!skipSignature) {
		const sigData = new DataView((await readBytes(stream, 4))!.buffer);
		const signature = sigData.getUint32(0, true);
		if (signature !== SIGNATURE_FILE) {
			return null;
		}
	}
	const data = new DataView((await readBytes(stream, 26))!.buffer);
	const entry: Partial<FileEntry> = {
		signature: SIGNATURE_FILE,
		version: data.getUint32(0, true),
		generalPurpose: data.getUint16(2, true),
		compressionMethod: data.getUint16(4, true),
		lastModifiedTime: data.getUint16(6, true),
		lastModifiedDate: data.getUint16(8, true),
		crc: data.getUint32(10, true),
		compressedSize: data.getUint32(14, true),
		uncompressedSize: data.getUint32(18, true),
		fileNameLength: data.getUint16(22, true),
		extraLength: data.getUint16(24, true),
	};

	entry['fileName'] = await readString(stream, entry['fileNameLength']!);
	entry['isDirectory'] = entry.fileName!.endsWith('/');
	entry['extra'] = await readBytes(stream, entry['extraLength']);

	// Make sure we consume the body stream or else
	// we'll start reading the next file at the wrong
	// offset.
	// @TODO: Expose the body stream instead of reading it all
	//        eagerly. Ensure the next iteration exhausts
	//        the last body stream before moving on.
	let bodyStream = limitBytes(stream, entry['compressedSize']!);
	if (entry['compressionMethod'] === 8) {
		bodyStream = bodyStream.pipeThrough(
			new DecompressionStream('deflate-raw')
		);
	}
	const body = await bodyStream
		.pipeThrough(concatBytesStream())
		.getReader()
		.read()
		.then(({ value }) => value!);
	entry['bytes'] = () => Promise.resolve(body);
	entry['text'] = () => Promise.resolve(new TextDecoder().decode(body));
	return entry as FileEntry;
}

export interface CentralDirectoryEntry {
	signature: typeof SIGNATURE_CENTRAL_DIRECTORY_START;
	versionCreated: number;
	versionNeeded: number;
	generalPurpose: number;
	compressionMethod: number;
	lastModifiedTime: number;
	lastModifiedDate: number;
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	fileNameLength: number;
	extraLength: number;
	fileCommentLength: number;
	diskNumber: number;
	internalAttributes: number;
	externalAttributes: number;
	firstByteAt: number;
	lastByteAt: number;
	fileName: string;
	extra: Uint8Array;
	fileComment: string;
	isDirectory: boolean;
}

async function readCentralDirectory(
	stream: ReadableStream<Uint8Array>,
	skipSignature = false
): Promise<CentralDirectoryEntry | null> {
	if (!skipSignature) {
		const sigData = new DataView((await readBytes(stream, 4))!.buffer);
		const signature = sigData.getUint32(0, true);
		if (signature !== SIGNATURE_CENTRAL_DIRECTORY_START) {
			return null;
		}
	}
	const data = new DataView((await readBytes(stream, 42))!.buffer);
	const centralDirectory: Partial<CentralDirectoryEntry> = {
		signature: SIGNATURE_CENTRAL_DIRECTORY_START,
		versionCreated: data.getUint16(0, true),
		versionNeeded: data.getUint16(2, true),
		generalPurpose: data.getUint16(4, true),
		compressionMethod: data.getUint16(6, true),
		lastModifiedTime: data.getUint16(8, true),
		lastModifiedDate: data.getUint16(10, true),
		crc: data.getUint32(12, true),
		compressedSize: data.getUint32(16, true),
		uncompressedSize: data.getUint32(20, true),
		fileNameLength: data.getUint16(24, true),
		extraLength: data.getUint16(26, true),
		fileCommentLength: data.getUint16(28, true),
		diskNumber: data.getUint16(30, true),
		internalAttributes: data.getUint16(32, true),
		externalAttributes: data.getUint32(34, true),
		firstByteAt: data.getUint32(38, true),
	};
	centralDirectory['lastByteAt'] =
		centralDirectory.firstByteAt! +
		FILE_HEADER_SIZE +
		centralDirectory.fileNameLength! +
		centralDirectory.fileCommentLength! +
		centralDirectory.extraLength! +
		centralDirectory.compressedSize! -
		1;

	centralDirectory['fileName'] = await readString(
		stream,
		centralDirectory.fileNameLength!
	);
	centralDirectory['isDirectory'] = centralDirectory.fileName!.endsWith('/');
	centralDirectory['extra'] = await readBytes(
		stream,
		centralDirectory.extraLength!
	);
	centralDirectory['fileComment'] = await readString(
		stream,
		centralDirectory.fileCommentLength!
	);
	return centralDirectory as CentralDirectoryEntry;
}

export interface CentralDirectoryEndEntry {
	signature: typeof SIGNATURE_CENTRAL_DIRECTORY_END;
	numberOfDisks: number;
	centralDirectoryStartDisk: number;
	numberCentralDirectoryRecordsOnThisDisk: number;
	numberCentralDirectoryRecords: number;
	centralDirectorySize: number;
	centralDirectoryOffset: number;
	commentLength: number;
	comment: string;
}

async function readEndCentralDirectory(
	stream: ReadableStream<Uint8Array>,
	skipSignature = false
) {
	if (!skipSignature) {
		const sigData = new DataView((await readBytes(stream, 4))!.buffer);
		const signature = sigData.getUint32(0, true);
		if (signature !== SIGNATURE_CENTRAL_DIRECTORY_END) {
			return null;
		}
	}
	const data = new DataView((await readBytes(stream, 18))!.buffer);
	const endOfDirectory: Partial<CentralDirectoryEndEntry> = {
		signature: SIGNATURE_CENTRAL_DIRECTORY_END,
		numberOfDisks: data.getUint16(0, true),
		centralDirectoryStartDisk: data.getUint16(2, true),
		numberCentralDirectoryRecordsOnThisDisk: data.getUint16(4, true),
		numberCentralDirectoryRecords: data.getUint16(6, true),
		centralDirectorySize: data.getUint32(8, true),
		centralDirectoryOffset: data.getUint32(12, true),
		commentLength: data.getUint16(16, true),
	};
	endOfDirectory['comment'] = await readString(
		stream,
		endOfDirectory.commentLength!
	);
	return endOfDirectory as CentralDirectoryEndEntry;
}

function concatString() {
	const chunks: string[] = [];
	return new TransformStream<string, string>({
		transform(chunk) {
			chunks.push(chunk);
		},

		flush(controller) {
			controller.enqueue(chunks.join(''));
		},
	});
}

function concatNBytes(totalBytes?: number) {
	const buffer = new ArrayBuffer(totalBytes || 0);
	let offset = 0;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk) {
			const view = new Uint8Array(buffer);
			view.set(chunk, offset);
			offset += chunk.length;
		},

		flush(controller) {
			controller.enqueue(new Uint8Array(buffer));
		},
	});
}

export function concatBytesStream() {
	const chunks: Uint8Array[] = [];
	let size = 0;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk) {
			chunks.push(chunk);
			size += chunk.length;
		},

		flush(controller) {
			const result = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.length;
			}
			controller.enqueue(new Uint8Array(result));
		},
	});
}

function centralDirectoryEntries(source: BytesSource) {
	let centralDirectoryStream: ReadableStream<Uint8Array>;

	return new ReadableStream<CentralDirectoryEntry>({
		async start() {
			centralDirectoryStream = await streamCentralDirectory(source);
		},
		async pull(controller) {
			try {
				const entry = await readCentralDirectory(
					centralDirectoryStream
				);
				if (!entry) {
					controller.close();
					return;
				}
				controller.enqueue(entry);
			} catch (e) {
				console.error(e);
				controller.error(e);
				throw e;
			}
		},
	});
}

async function streamCentralDirectory(source: BytesSource) {
	const chunkSize = CENTRAL_DIRECTORY_END_SCAN_CHUNK_SIZE;
	let centralDirectory: Uint8Array = new Uint8Array();

	let chunkStart = source.length;
	do {
		chunkStart = Math.max(0, chunkStart - chunkSize);
		const chunkEnd = Math.min(
			chunkStart + chunkSize - 1,
			source.length - 1
		);
		const bytes = await readBytes(
			await source.streamBytes(chunkStart, chunkEnd)
		);
		centralDirectory = concatUint8Array(bytes!, centralDirectory);

		// Scan the buffer for the signature
		const view = new DataView(bytes!.buffer);
		for (let i = view.byteLength - 4; i >= 0; i--) {
			if (view.getUint32(i, true) !== SIGNATURE_CENTRAL_DIRECTORY_END) {
				continue;
			}

			// Confirm we have enough data to read the offset and the
			// length of the central directory.
			const centralDirectoryLengthAt = i + 12;
			const centralDirectoryOffsetAt = centralDirectoryLengthAt + 4;
			if (centralDirectory.byteLength < centralDirectoryOffsetAt + 4) {
				throw new Error('Central directory not found');
			}

			// Read where the central directory starts
			const dirStart = view.getUint32(centralDirectoryOffsetAt, true);
			if (dirStart < chunkStart) {
				// We're missing some bytes, let's grab them
				const missingBytes = await readBytes(
					await source.streamBytes(dirStart, chunkStart - 1)
				);
				centralDirectory = concatUint8Array(
					missingBytes!,
					centralDirectory
				);
			} else if (dirStart > chunkStart) {
				// We've read too many bytes, let's trim them
				centralDirectory = centralDirectory.slice(
					dirStart - chunkStart
				);
			}
			return new Blob([centralDirectory]).stream();
		}
	} while (chunkStart >= 0);

	throw new Error('Central directory not found');
}

// Asynchronous iteration is not yet implemented in any browser.
// A workaround to use asynchronous iteration today is to implement the behavior with a polyfill.
// @ts-ignore
if (!ReadableStream.prototype[Symbol.asyncIterator]) {
	// @ts-ignore
	ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
		const reader = this.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					return;
				}
				yield value;
			}
		} finally {
			reader.releaseLock();
		}
	};
}

async function readString(stream: ReadableStream<Uint8Array>, bytes: number) {
	return await limitBytes(stream, bytes)
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(concatString())
		.getReader()
		.read()
		.then(({ value }) => value);
}

async function readBytes(stream: ReadableStream<Uint8Array>, bytes?: number) {
	if (bytes === undefined) {
		return await stream
			.pipeThrough(concatBytesStream())
			.getReader()
			.read()
			.then(({ value }) => value);
	}

	return await limitBytes(stream, bytes)
		.pipeThrough(concatNBytes(bytes))
		.getReader()
		.read()
		.then(({ value }) => value);
}

function limitBytes(stream: ReadableStream<Uint8Array>, bytes: number) {
	if (bytes === 0) {
		return new ReadableStream({
			start(controller) {
				controller.close();
			},
		});
	}
	const reader = stream.getReader({ mode: 'byob' });
	let offset = 0;
	return new ReadableStream({
		async pull(controller) {
			const { value, done } = await reader.read(
				new Uint8Array(bytes - offset)
			);
			if (done) {
				reader.releaseLock();
				controller.close();
				return;
			}
			offset += value.length;
			controller.enqueue(value);

			if (offset >= bytes) {
				reader.releaseLock();
				controller.close();
			}
		},
		cancel() {
			reader.cancel();
		},
	});
}

function partitionNearbyEntries({ maxGap = -10 * 1024 } = {}) {
	let lastFileEndsAt = 0;
	let currentChunk: CentralDirectoryEntry[] = [];
	return new TransformStream<CentralDirectoryEntry, CentralDirectoryEntry[]>({
		transform(zipEntry, controller) {
			// Byte distance too large, flush and start a new chunk
			if (zipEntry.firstByteAt > lastFileEndsAt + maxGap) {
				controller.enqueue(currentChunk);
				currentChunk = [];
			}
			lastFileEndsAt = zipEntry.lastByteAt;
			currentChunk.push(zipEntry);
		},
		flush(controller) {
			controller.enqueue(currentChunk);
		},
	});
}

function fetchPartitionedEntries(
	source: BytesSource
): ReadableWritablePair<FileEntry, CentralDirectoryEntry[]> {
	let isWritableClosed = false;
	let requestsInProgress = 0;
	let readableController: ReadableStreamDefaultController<FileEntry>;
	const byteStreams: Array<
		[CentralDirectoryEntry[], ReadableStream<Uint8Array>]
	> = [];
	const readable = new ReadableStream<FileEntry>({
		start(controller) {
			readableController = controller;
		},
		async pull(controller) {
			while (true) {
				if (
					isWritableClosed &&
					!byteStreams.length &&
					requestsInProgress === 0
				) {
					controller.close();
					return;
				}

				if (!byteStreams.length) {
					await new Promise((resolve) => setTimeout(resolve, 50));
					continue;
				}

				const [zipEntries, stream] = byteStreams[0];
				const file = await readFileEntry(stream);
				if (!file) {
					byteStreams.shift();
					continue;
				}

				const isOneOfRequestedFiles = zipEntries.find(
					(entry) => entry.fileName === file.fileName
				);
				if (!isOneOfRequestedFiles) {
					continue;
				}
				controller.enqueue(file);
				break;
			}
		},
	});
	const writable = new WritableStream<CentralDirectoryEntry[]>({
		write(zipEntries, controller) {
			if (!zipEntries.length) {
				return;
			}
			++requestsInProgress;
			// If the write() method returns a promise, the next
			// call will be delayed until the promise resolves.
			// Let's not return the promise, then.
			// This will effectively issue many requests in parallel.
			requestChunkRange(source, zipEntries)
				.then((byteStream) => {
					byteStreams.push([zipEntries, byteStream]);
				})
				.catch((e) => {
					controller.error(e);
				})
				.finally(() => {
					--requestsInProgress;
				});
		},
		abort() {
			isWritableClosed = true;
			readableController.close();
		},
		async close() {
			isWritableClosed = true;
		},
	});

	return {
		readable,
		writable,
	};
}

const sem = new Semaphore({ concurrency: 10 });
async function requestChunkRange(
	source: BytesSource,
	zipEntries: CentralDirectoryEntry[]
) {
	const release = await sem.acquire();
	try {
		const lastZipEntry = zipEntries[zipEntries.length - 1];
		const substream = await source.streamBytes(
			zipEntries[0].firstByteAt,
			lastZipEntry.lastByteAt
		);
		return substream;
	} catch (e) {
		console.error(e);
		throw e;
	} finally {
		release();
	}
}

type BytesSource = {
	length: number;
	streamBytes: (
		start: number,
		end: number
	) => Promise<ReadableStream<Uint8Array>>;
};

async function createFetchSource(url: string): Promise<BytesSource> {
	const response = await fetch(url, { method: 'HEAD' });
	if (!response.ok) throw new Error('Failed to fetch the ZIP file');

	const contentLength = response.headers.get('Content-Length');
	if (!contentLength) throw new Error('Content-Length header is missing');

	const streamBytes = async (from: number, to: number) =>
		await fetch(url, {
			headers: {
				Range: `bytes=${from}-${to}`,
				'Accept-Encoding': 'none',
			},
		}).then((response) => response.body!);

	return {
		streamBytes,
		length: parseInt(contentLength, 10),
	};
}

function concatUint8Array(...arrays: Uint8Array[]) {
	const result = new Uint8Array(
		arrays.reduce((sum, array) => sum + array.length, 0)
	);
	let offset = 0;
	for (const array of arrays) {
		result.set(array, offset);
		offset += array.length;
	}
	return result;
}

// @ts-ignore
if (!ReadableStream.prototype[Symbol.asyncIterator]) {
	// @ts-ignore
	ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
		const reader = this.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					return;
				}
				yield value;
			}
		} finally {
			reader.releaseLock();
		}
	};
}

type IterableReadableStream<R> = ReadableStream<R> & {
	[Symbol.asyncIterator](): AsyncIterableIterator<R>;
};

function filterStream<T>(filter: (chunk: T) => boolean) {
	return new TransformStream<T, T>({
		transform(chunk, controller) {
			if (filter(chunk)) {
				controller.enqueue(chunk);
			}
		},
	});
}

const predicate = ({ isDirectory, uncompressedSize }: CentralDirectoryEntry) =>
	!isDirectory || uncompressedSize !== 0;

// Get specific files from a ZIP archive
function iterateZipFiles2(
	source: BytesSource,
	predicate: (dirEntry: CentralDirectoryEntry) => boolean
) {
	return centralDirectoryEntries(source)
		.pipeThrough(filterStream(predicate))
		.pipeThrough(partitionNearbyEntries())
		.pipeThrough(
			fetchPartitionedEntries(source)
		) as IterableReadableStream<FileEntry>;
}
const source = await createFetchSource(
	'https://downloads.wordpress.org/plugin/classic-editor.latest-stable.zip'
	// 'https://github.com/Automattic/themes/archive/refs/heads/trunk.zip'
	// 'https://downloads.wordpress.org/plugin/gutenberg.latest-stable.zip'
	// 'https://wordpress.org/nightly-builds/wordpress-latest.zip'
);
const files = iterateZipFiles2(source, predicate);
console.log('iterateZipFiles2');
for await (const file of files) {
	console.log(file.fileName);
}

// Read an entire ZIP archive
function readEntireZip(
	stream: ReadableStream<Uint8Array>,
	predicate: (entry: FileEntry) => boolean
) {
	return zipEntries(stream)
		.pipeThrough(
			filterStream(({ signature }) => signature === SIGNATURE_FILE)
		)
		.pipeThrough(
			filterStream(predicate)
		) as IterableReadableStream<FileEntry>;
}

const response = await fetch(
	'https://downloads.wordpress.org/plugin/classic-editor.latest-stable.zip'
);
const allFiles = readEntireZip(response.body!, predicate as any);
console.log('readEntireZip');
for await (const file of allFiles) {
	console.log(file.fileName);
}

export function iterateZipFiles(a: any): any {}

throw new Error('Expected halt');

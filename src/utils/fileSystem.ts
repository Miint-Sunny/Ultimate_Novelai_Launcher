
export type FileSystemHandle = FileSystemFileHandle | FileSystemDirectoryHandle;

export interface FileSystemDirectoryHandle {
    kind: 'directory';
    name: string;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
    removeEntry(name: string): Promise<void>;
    values(): AsyncIterableIterator<FileSystemHandle>;
    queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface FileSystemFileHandle {
    kind: 'file';
    name: string;
    getFile(): Promise<File>;
    createWritable(): Promise<FileSystemWritableFileStream>;
    queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface FileSystemWritableFileStream extends WritableStream {
    write(data: any): Promise<void>;
    close(): Promise<void>;
}

export const getFilesFromDirectory = async (directoryHandle: FileSystemDirectoryHandle): Promise<File[]> => {
    const files: File[] = [];
    for await (const entry of directoryHandle.values()) {
        if (entry.kind === 'file') {
            // entry is narrowed to FileSystemFileHandle automatically
            const file = await entry.getFile();
            files.push(file);
        }
    }
    return files;
};

// 扫描目录中的 .naiv4vibe 文件并解析内容
export interface ParsedVibeFile {
    fileName: string;
    id: string;
    name: string;
    size: string;
    preview: string;
    image?: string;
    encodings?: Record<string, Record<string, { encoding: string; params: { information_extracted: number } }>>;
    defaultStrength?: number;
    defaultInfoExtracted?: number;
    supportedModels?: string[];
    createdAt?: number;
}

export const scanVibeFilesFromDirectory = async (directoryHandle: FileSystemDirectoryHandle): Promise<ParsedVibeFile[]> => {
    const vibeFiles: ParsedVibeFile[] = [];
    
    for await (const entry of directoryHandle.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.naiv4vibe')) {
            try {
                const file = await entry.getFile();
                const content = await file.text();
                const data = JSON.parse(content);
                
                if (data.identifier !== 'novelai-vibe-transfer') {
                    continue;
                }
                
                const supportedModels = data.encodings ? Object.keys(data.encodings) : [];
                
                vibeFiles.push({
                    fileName: entry.name,
                    id: data.id || entry.name,
                    name: data.name || entry.name.replace('.naiv4vibe', ''),
                    size: (file.size / 1024 / 1024).toFixed(2) + ' MB',
                    preview: data.thumbnail || '',
                    image: data.image,
                    encodings: data.encodings,
                    defaultStrength: data.importInfo?.strength,
                    defaultInfoExtracted: data.importInfo?.information_extracted,
                    supportedModels,
                    createdAt: data.createdAt,
                });
            } catch (err) {
                console.error(`Error parsing vibe file ${entry.name}:`, err);
            }
        }
    }
    
    // 按创建时间排序，最新的在前
    vibeFiles.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    
    return vibeFiles;
};

export const saveFileToDirectory = async (directoryHandle: FileSystemDirectoryHandle, file: File): Promise<void> => {
    const fileHandle = await directoryHandle.getFileHandle(file.name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file);
    await writable.close();
};

// 保存 vibe 数据到目录
export const saveVibeToDirectory = async (
    directoryHandle: FileSystemDirectoryHandle, 
    fileName: string, 
    content: string
): Promise<void> => {
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
};

export const deleteFileFromDirectory = async (directoryHandle: FileSystemDirectoryHandle, fileName: string): Promise<void> => {
    await directoryHandle.removeEntry(fileName);
};

/**
 * 生成基于时间戳的图片文件名
 * 格式: novelai_YYYYMMDD_HHmmss{suffix}.{ext}
 * @param suffix 文件名后缀（如 _clean, _custom）
 * @param timestamp 生成时间的毫秒时间戳，不传则使用当前时间
 * @param ext 文件扩展名，默认 png
 */
export function generateImageFileName(suffix: string = '', timestamp?: number, ext: string = 'png'): string {
    const now = timestamp ? new Date(timestamp) : new Date();
    const ts = now.getFullYear().toString()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + '_'
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
    return `novelai_${ts}${suffix}.${ext}`;
}

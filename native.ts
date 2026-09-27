import { writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export async function saveJson(_: any, filename: string, data: string) {
    const filePath = join(homedir(), "Downloads", filename);
    await writeFile(filePath, data, "utf-8");
    return filePath;
}

export async function saveJsonChunk(_: any, filename: string, data: string) {
    const filePath = join(homedir(), "Downloads", filename);
    await writeFile(filePath, data, "utf-8");
    return filePath;
}

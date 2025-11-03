// /utils/filedb.js
import fs from 'fs-extra';

// JSON 읽기 (없으면 fallback 리턴)
export async function readJson(path, fallback = {}) {
  try {
    if (!(await fs.pathExists(path))) return fallback;
    return await fs.readJson(path);
  } catch (err) {
    console.error('readJson error:', err);
    return fallback;
  }
}

// JSON 쓰기
export async function writeJson(path, data) {
  try {
    await fs.ensureFile(path);
    await fs.writeJson(path, data, { spaces: 2 });
  } catch (err) {
    console.error('writeJson error:', err);
  }
}

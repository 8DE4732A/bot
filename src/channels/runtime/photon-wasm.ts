// Bun 资源导入：源码运行时指向 node_modules 里的文件，`bun build --compile`
// 则把 wasm 放进二进制的虚拟文件系统（/$bunfs/...）；两种形态都能用 node:fs 读。
import { readFile } from "node:fs/promises";
import photonWasmPath from "@silvia-odwyer/photon/photon_rs_bg.wasm" with { type: "file" };

/** Photon 的 wasm 字节，供单文件二进制里创建进程内 `ImageProcessor`。 */
export async function readPhotonWasm(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(photonWasmPath));
}

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import satori from "satori";
import sharp from "sharp";

export const WIDTH = 1200;
export const HEIGHT = 630;
const subsets = ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"];
const font = (subset: string) =>
  readFile(
    fileURLToPath(
      import.meta.resolve(
        `@fontsource/inter/files/inter-${subset}-700-normal.woff`,
      ),
    ),
  );
const resources = (async () => {
  const [template, ...faces] = await Promise.all([
    readFile(new URL("./assets/post-template.png", import.meta.url)),
    ...subsets.map(font),
  ]);
  return {
    templateUri: `data:image/png;base64,${template.toString("base64")}`,
    fonts: faces.map((data, index) => ({
      name: `Inter-${subsets[index]}`,
      data,
      weight: 700 as const,
      style: "normal" as const,
    })),
  };
})();

export type Node = { type: string; props: Record<string, unknown> };
export const h = (
  type: string,
  style: Record<string, unknown>,
  children?: unknown,
): Node => ({ type, props: { style: { display: "flex", ...style }, children } });

export function avatarNode(avatar: string | null, name: string, size: number): Node {
  if (avatar) {
    return {
      type: "img",
      props: { src: avatar, width: size, height: size, style: { borderRadius: size / 2 } },
    };
  }
  return h(
    "div",
    {
      width: size,
      height: size,
      borderRadius: size / 2,
      background: "#16dc64",
      color: "#101010",
      fontSize: size / 2,
      fontWeight: 700,
      alignItems: "center",
      justifyContent: "center",
    },
    [...name][0]?.toUpperCase() ?? "?",
  );
}

export async function renderCard(content: Node[]) {
  const { templateUri, fonts } = await resources;
  const root = h(
    "div",
    {
      width: WIDTH,
      height: HEIGHT,
      position: "relative",
      fontFamily: subsets.map((subset) => `Inter-${subset}`).join(", "),
      color: "#f5f5f5",
    },
    [
      {
        type: "img",
        props: {
          src: templateUri,
          width: WIDTH,
          height: HEIGHT,
          style: { position: "absolute", top: 0, left: 0 },
        },
      },
      ...content,
    ],
  );
  const svg = await satori(root as never, { width: WIDTH, height: HEIGHT, fonts });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function avatarDataUri(bytes: Uint8Array) {
  const png = await sharp(bytes)
    .resize(128, 128, { fit: "cover" })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

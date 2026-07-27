import { getImageMetadata, resizeToPng } from "../media/image-ops.js";
import { detectMime } from "../media/mime.js";
import type { GeneratedImageAsset, ImageGenerationOutputFormat } from "./types.js";

const OUTPUT_MIME: Record<ImageGenerationOutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

type OutputFormatDeps = {
  detectMime?: typeof detectMime;
  getImageMetadata?: typeof getImageMetadata;
  resizeToPng?: typeof resizeToPng;
};

function withFileExtension(fileName: string | undefined, extension: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const base = fileName.replace(/\.[^./\\]+$/, "");
  return `${base}.${extension}`;
}

export async function normalizeGeneratedImageOutputFormat(
  images: GeneratedImageAsset[],
  outputFormat: ImageGenerationOutputFormat | undefined,
  deps: OutputFormatDeps = {},
): Promise<GeneratedImageAsset[]> {
  if (!outputFormat) {
    return images;
  }
  const expectedMime = OUTPUT_MIME[outputFormat];
  const detect = deps.detectMime ?? detectMime;
  const metadata = deps.getImageMetadata ?? getImageMetadata;
  const convertToPng = deps.resizeToPng ?? resizeToPng;

  return await Promise.all(
    images.map(async (image) => {
      const observedMime = await detect({ buffer: image.buffer });
      if (observedMime === expectedMime) {
        return {
          ...image,
          mimeType: expectedMime,
          fileName: withFileExtension(image.fileName, outputFormat),
        };
      }

      if (outputFormat !== "png") {
        throw new Error(
          `Image generation returned ${observedMime ?? image.mimeType} for requested ${expectedMime}`,
        );
      }
      const dimensions = await metadata(image.buffer);
      if (!dimensions) {
        throw new Error("Image generation output could not be decoded for PNG conversion");
      }
      const converted = await convertToPng({
        buffer: image.buffer,
        maxSide: Math.max(dimensions.width, dimensions.height),
        compressionLevel: 6,
        withoutEnlargement: true,
      });
      const convertedMime = await detect({ buffer: converted });
      if (convertedMime !== expectedMime) {
        throw new Error(
          `Image generation PNG conversion returned ${convertedMime ?? "unknown format"}`,
        );
      }
      return {
        ...image,
        buffer: converted,
        mimeType: expectedMime,
        fileName: withFileExtension(image.fileName, outputFormat),
        metadata: {
          ...image.metadata,
          sourceMimeType: observedMime ?? image.mimeType,
          outputFormatConverted: true,
        },
      };
    }),
  );
}

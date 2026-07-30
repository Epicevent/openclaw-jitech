import { describe, expect, it, vi } from "vitest";
import { normalizeGeneratedImageOutputFormat } from "./output-format.js";

describe("normalizeGeneratedImageOutputFormat", () => {
  it("converts a provider JPEG into real PNG bytes when PNG was requested", async () => {
    const source = Buffer.from("jpeg-bytes");
    const png = Buffer.from("png-bytes");
    const detectMime = vi
      .fn()
      .mockResolvedValueOnce("image/jpeg")
      .mockResolvedValueOnce("image/png");
    const resizeToPng = vi.fn().mockResolvedValue(png);

    const result = await normalizeGeneratedImageOutputFormat(
      [{ buffer: source, mimeType: "image/jpeg", fileName: "image-1.jpg" }],
      "png",
      {
        detectMime,
        getImageMetadata: vi.fn().mockResolvedValue({ width: 1024, height: 768 }),
        resizeToPng,
      },
    );

    expect(resizeToPng).toHaveBeenCalledWith({
      buffer: source,
      maxSide: 1024,
      compressionLevel: 6,
      withoutEnlargement: true,
    });
    expect(result[0]).toMatchObject({
      buffer: png,
      mimeType: "image/png",
      fileName: "image-1.png",
      metadata: {
        sourceMimeType: "image/jpeg",
        outputFormatConverted: true,
      },
    });
  });

  it("fails closed when the converted bytes are not PNG", async () => {
    await expect(
      normalizeGeneratedImageOutputFormat(
        [{ buffer: Buffer.from("jpeg"), mimeType: "image/jpeg" }],
        "png",
        {
          detectMime: vi
            .fn()
            .mockResolvedValueOnce("image/jpeg")
            .mockResolvedValueOnce("image/jpeg"),
          getImageMetadata: vi.fn().mockResolvedValue({ width: 1, height: 1 }),
          resizeToPng: vi.fn().mockResolvedValue(Buffer.from("still-jpeg")),
        },
      ),
    ).rejects.toThrow("PNG conversion returned image/jpeg");
  });

  it("does not rewrite image bytes that already have the requested byte format", async () => {
    const buffer = Buffer.from("png");
    const detectMime = vi.fn().mockResolvedValue("image/png");
    const result = await normalizeGeneratedImageOutputFormat(
      [{ buffer, mimeType: "image/png", fileName: "image-1.jpg" }],
      "png",
      { detectMime },
    );
    expect(result).toEqual([{ buffer, mimeType: "image/png", fileName: "image-1.png" }]);
    expect(detectMime).toHaveBeenCalledWith({ buffer });
  });

  it("converts bytes when a provider falsely labels JPEG bytes as PNG", async () => {
    const source = Buffer.from("jpeg-bytes");
    const png = Buffer.from("png-bytes");
    const result = await normalizeGeneratedImageOutputFormat(
      [{ buffer: source, mimeType: "image/png", fileName: "image-1.png" }],
      "png",
      {
        detectMime: vi.fn().mockResolvedValueOnce("image/jpeg").mockResolvedValueOnce("image/png"),
        getImageMetadata: vi.fn().mockResolvedValue({ width: 2, height: 1 }),
        resizeToPng: vi.fn().mockResolvedValue(png),
      },
    );
    expect(result[0]).toMatchObject({
      buffer: png,
      mimeType: "image/png",
      metadata: { sourceMimeType: "image/jpeg", outputFormatConverted: true },
    });
  });
});

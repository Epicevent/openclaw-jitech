import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const statusMock = vi.hoisted(() => vi.fn());
const proofMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/kwrag-p1-thin.js", () => ({
  readKwragP1AttachmentStatus: statusMock,
  runKwragP1UserTurnProof: proofMock,
}));

import { registerKwragP0Cli } from "./kwrag-p0-cli.js";

function program(): Command {
  const value = new Command();
  value.exitOverride();
  registerKwragP0Cli(value);
  return value;
}

describe("kwrag-p1 attachment CLI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    statusMock.mockReset();
    proofMock.mockReset();
  });

  it("exposes the fixed status argv as exact JSON", async () => {
    const status = { schema: "jitech-embedded-retrieval-attachment-status/v1" };
    statusMock.mockReturnValueOnce(status);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program().parseAsync(["node", "openclaw", "kwrag-p0", "p1-attachment-status", "--json"]);

    expect(statusMock).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(status)}\n`);
  });

  it("runs the actual user-turn proof only through the fixed no-input command", async () => {
    const proof = { schema: "jitech-openclaw-kwrag-user-turn-proof/v1" };
    proofMock.mockResolvedValueOnce(proof);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program().parseAsync(["node", "openclaw", "kwrag-p0", "p1-user-turn-proof", "--json"]);

    expect(proofMock).toHaveBeenCalledWith();
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(proof)}\n`);
  });

  it.each(["p1-attachment-status", "p1-user-turn-proof"])(
    "rejects %s without --json before product execution",
    async (command) => {
      await expect(program().parseAsync(["node", "openclaw", "kwrag-p0", command])).rejects.toThrow(
        /requires --json/u,
      );
      expect(statusMock).not.toHaveBeenCalled();
      expect(proofMock).not.toHaveBeenCalled();
    },
  );
});

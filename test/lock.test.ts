// 이 페이지가 만든 잠금 파일을 qoro insight 의 발행 화면과 **같은 검사**(src/lib/lockFile.ts — insight 에서 복사된 파일)가 받는가.
// 키는 파일에 없다 — 그것까지 확인한다. 네트워크는 쓰지 않는다(잠금은 오프라인이다).
import { describe, expect, it, vi } from "vitest";
import { sealLockFile } from "@/lib/lockSeal";
import { parseLockFile } from "@/lib/lockFile";
import { sealedRoundOf } from "@/lib/tlock";

const NOW = Date.UTC(2026, 9, 18);
const PNG = "data:image/png;base64," + Buffer.from("not-really-a-png").toString("base64");

describe("잠금 파일", () => {
  it("네트워크 없이 만들고, 발행 화면의 검사를 통과한다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network used");
    });
    try {
      const r = await sealLockFile(
        { title: "제목", preview: "미리보기", openDateMs: NOW + 40 * 86_400_000, ops: [{ insert: "본문\n" }, { insert: { image: PNG } }, { insert: "\n" }] },
        { nowMs: NOW, commit: "test" },
      );
      if (!r.ok) throw new Error(r.problem);
      const p = await parseLockFile(r.json, NOW);
      expect(p.ok).toBe(true);
      expect(sealedRoundOf(r.file.sealedKdoc)).toBe(r.file.round);
      expect(r.file.images).toHaveLength(1);
      expect(r.json).not.toMatch(/"kDoc/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("손댄 파일은 받지 않는다", async () => {
    const r = await sealLockFile(
      { title: "제목", preview: "미리보기", openDateMs: NOW + 40 * 86_400_000, ops: [{ insert: "본문\n" }] },
      { nowMs: NOW, commit: "test" },
    );
    if (!r.ok) throw new Error(r.problem);
    const f = JSON.parse(r.json);
    f.round += 1;
    expect((await parseLockFile(JSON.stringify(f), NOW)).ok).toBe(false);
  });
});

# Sol Ultra Gearbox V2 復盤

- 日期：2026-07-13
- 範圍：typed role 路由、全域安裝、live smoke、回滾、額度估算
- 結論：保留並延伸現有 Gearbox repo；不新增 skill、automation 或更多 custom agent。

## 結論先行

這次工作的最終結果是成功，但成功點不在最初的設定猜測，而在後來補上的 fail-closed 驗證：實際啟動角色、讀取 persisted rollout metadata、限制深度與寫入範圍、驗證全域 config 前後 hash，以及保留可回滾 manifest。

最終五個 live role probes 全數通過，typed role、model、reasoning effort、sandbox、`fork_turns="none"`、depth 1 與禁止 descendants 都有 persisted evidence。最終 smoke 執行期間全域 config hash 未改變。

這套流程已足以投入受控使用，但還不能宣稱「所有真實工作都固定省 40%」。目前直接證明的是 child layer 的模型路由與一次合成測試成本；真實專案的總成本仍需納入 root orchestration、返工與工作難度。

## 證據基線

| 時點 | 已驗證事實 | 證據 |
|---|---|---|
| 2026-07-12 | 隔離 CLI 曾成功啟動 typed Terra；同時，當時 daily Desktop profile 全域開啟 v2 會遇到 reserved schema mismatch，已回滾 | 先前 rollout 復盤 |
| 2026-07-13 07:38 | live smoke 失敗，Codex 明確回報 `agents.max_threads cannot be set when features.multi_agent_v2 is enabled` | `reports/20260713073839-smoke/smoke.json` |
| 2026-07-13 07:46 | managed config、六個 role files、launcher 與全域 AGENTS 規則安裝完成；post-install root smoke 通過 | `reports/20260713074627-apply/install-manifest.json` |
| 2026-07-13 08:06 | 五個角色 full live smoke 全數通過；全域 config before/after hash 相同 | `reports/20260713080612-smoke/smoke.json` |
| 2026-07-13 09:14–09:19 | 現行 Codex CLI 0.144.2；閃退重開前後 doctor 均通過；apply dry-run 顯示 config 與 AGENTS 均 `changed: false` | 本次復盤唯讀檢查 |
| 2026-07-13 09:36 | 開源修正版五角色 smoke 全數通過；parent 與 child token usage 皆持久化；全域 config 同次前後未變 | local-only smoke report；公開摘要見 `docs/RELEASE_EVIDENCE.md` |

全域 config hash 在 08:06 smoke 為 `770932…`，09:14 為 `f22e6e…`，閃退重開後 09:19 又成為 `3cf029…`。目前 config 內可見 Codex app 維護的 project registry，包含本 repo；這與 app 在 task 建立或重開時更新 trust state 的行為相符，但因沒有保存每次完整 snapshot，不能把它寫成已證實的唯一根因。已確認 Gearbox managed blocks 完整、沒有 Gearbox 暫存 fixture entries、doctor 通過且 dry-run idempotent。

因此，副作用判定只使用**同一次隔離 smoke 執行前後**的 hash 比較；跨 task、跨重啟的整檔 hash 只能當漂移訊號，不能當 Gearbox 失敗判定。

## 實際時間線

1. 以既有 typed Terra 隔離成功與 Desktop schema mismatch 回滾作為基線，建立 repo-local source-of-truth。
2. 第一輪 live smoke 失敗，但報告把 stderr 過度遮蔽，沒有留下可診斷根因。
3. 補上 sanitized error summary 後重跑，定位到 v2 與 legacy `agents.max_threads` 互斥。
4. 改用 `features.multi_agent_v2.max_concurrent_threads_per_session = 2`，並用 managed marker 暫停原本 `max_threads = 3`；rollback 仍可原樣恢復。
5. 五個角色 smoke 通過後套用全域設定，post-install fresh-root smoke 也通過。
6. 套用後稽核發現 workspace-write probes 曾把兩個暫存 fixture 寫成全域 project trust entries。
7. 精準移除這兩個 owned entries，更新 manifest，並把所有後續 live probes 改成隔離 `CODEX_HOME`；只在程序存活期間連結既有 auth，且要求 global config hash 前後完全相同。
8. 完整重跑五個 live role probes，全部通過，沒有 schema mismatch、nested spawn 或越界寫入。

## 做對的地方

- Typed role 驗證讀 persisted lineage 與 runtime metadata，不採信模型自報。
- Parent spawn 只提供 `agent_type`、`fork_turns="none"` 與自包含任務，不覆寫 model、effort 或 service tier。
- Read-only 與 workspace-write roles 分離；寫入 probe 只允許改指定 fixture。
- Depth 固定 1，角色指令禁止再次委派。
- Global changes 使用 marker、backup、manifest 與自動 rollback，而不是整份覆寫 config。
- Smoke 無重試；遇到第一個不明失敗即停止，避免便宜模型的重試成本失控。
- Live smoke 後新增 global config immutability gate，補上原流程最重要的副作用檢查。

## 做錯或過度樂觀的地方

### 1. 把靜態相容性當成 runtime 相容性

`strict-config` 與 doctor 都不能取代真正的 thread start。`agents.max_threads` 衝突只有 live smoke 才暴露。未來任何 Codex 版本或 v2 schema 更新，都不能只看 TOML 可解析就宣稱完成。

### 2. 初版錯誤報告遮蔽太多

保護 secrets 是必要的，但把 stderr 整段拿掉讓失敗無法診斷。修正方向是只保留 sanitized error summary，而非保存完整 conversation 或 auth payload。

### 3. 初版 live smoke 污染真實 CODEX_HOME

即使測試 fixture 在暫存目錄，Codex 仍可能把 trust state 寫回真實 config。最終改成隔離 home 並做 hash gate 才算真正無副作用。

### 4. 初版成本報告只持久化 child usage

初版 `smoke.json` 保存了 child token usage，但沒有保存每個 root process 的 token usage。開源修正版已把 parent usage 納入 hard gate，並於 09:36 full smoke 實證五組 parent／child metadata 全部存在。價格公式仍刻意不寫死在 runtime report，避免費率變動後產生錯誤金額。

### 5. 測試 harness 不等於日常 Ultra

完整 smoke 為隔離風險，使用五個獨立 Sol parents 各啟動一個 child。真實 Ultra 通常是一個 root 協調數個 children，因此 harness 的整體節省比例會被重複 root overhead 稀釋，不能直接當成日常使用預測。

## 成本復盤

依 2026-07-13 官方 credit rates 快照計算：Sol 為 125／12.5／750、Terra 為 62.5／6.25／375、Luna 為 25／2.5／150 credits／百萬 uncached input、cached input、output tokens。價格會變動，使用前應重查官方 pricing。

| 指標 | Hybrid | 全部改用 Sol | 節省 |
|---|---:|---:|---:|
| 五個 child probes | 7.3927 credits | 13.7043 credits | 46.1% |
| 五-parent 測試 harness 估算 | 21.9863 credits | 28.2978 credits | 22.3% |

五個 children 共記錄 209,671 total tokens。46.1% 是可由 `smoke.json` 重算的 child-layer 結果；22.3% 含當次五個 root processes，因 root usage 尚未寫入報告，列為估算。

對日常單一 Sol root 協調 Terra／Luna workers，合理規劃值是整體先抓約 30% 節省；當大部分 token 確實落在便宜 children，才可能接近 40%。這是推論，不是目前已完成的長期實測。

## 封裝候選短名單

| 候選 | 證據與頻率 | 信心 | 決定 | 原因 |
|---|---|---:|---|---|
| 延伸現有 Gearbox repo 與復盤文件 | 本次已有多輪失敗、修正與完整 smoke | 高 | 建立本文件 | 保存根因與更新門檻，避免重踩 |
| 新增 Gearbox skill | 現有 CLI、README、AGENTS 與角色已覆蓋流程 | 高 | 跳過 | 會形成重複入口與觸發規則 |
| 新增更多 custom agents | 六個角色已覆蓋 clerk、explorer、worker、reviewer、specialist 與 legacy | 高 | 跳過 | 角色增殖會提高路由與維護成本 |
| 排程自動 full live smoke | 每次都消耗 credits；版本更新不定期 | 高 | 跳過 | 不應固定燒額度，也不需要背景執行 |
| 自動成本稽核／dashboard | 目前只有一次合成 smoke | 中 | 等待證據 | 先累積至少 10 個真實任務樣本 |
| Codex 更新後的相容性檢查 | 本次已證明靜態檢查不足 | 高 | 延伸既有 runbook | 用手動 gate 即可，不另建 automation |

## 後續操作門檻

Codex Desktop／CLI 更新、角色 TOML 變更或 v2 schema 變更後：

1. 先跑 `rtk npm run doctor -- --json`。
2. 再跑 `rtk node scripts/gearbox.mjs apply --promote-v2 --dry-run`。
3. schema 或 runtime 有變化時，先跑一個最低風險的 read-only role probe。
4. 只有前項通過且更新確實影響 multi-agent runtime，才重跑 `smoke --all`。
5. Smoke 報告必須同時通過 typed lineage、實際 model／effort／sandbox、depth、no descendants、filesystem scope 與 global config unchanged。
6. 現有 Desktop task 不會熱更新 tool schema；全域套用後要在 fresh task 驗證 `agent_type` surface。

## 還需要更多證據

- 至少 10 個真實、可比較的任務：記錄 root／child token、完成時間、返工次數與驗收結果。
- 累積真實任務後再決定是否把帶日期的 pricing snapshot 納入獨立成本報告；runtime smoke 只保存不易漂移的 token evidence。
- 在 fresh Desktop task 驗證 UI 實際暴露 `agent_type`；本 task 的工具 schema 是啟動時快照。
- Codex 0.144.3 或後續版本安裝後，重新執行相容性門檻，不沿用 0.144.2 結論。
- Repo 目前尚未 commit；在使用者確認後再建立基線 commit，否則 rollback 檔存在，但版本歷史仍不完整。

## 最終封裝決策

- 建立／延伸：現有 Gearbox repo 的復盤與更新 runbook。
- 刻意跳過：新 skill、新 automation、新 custom agent、再次付費 full smoke。
- 等待證據：真實任務的長期節省率、下一版 Codex 相容性、fresh Desktop task surface。

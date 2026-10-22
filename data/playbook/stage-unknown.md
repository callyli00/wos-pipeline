# 当前阶段没有专门判据

正常情况下不会走到这里：7 个阶段（created / imported / classified / downloading /
downloaded / parsed / wiki）都有对应的判据文件。

走到这里说明账本里的 `stage` 值不认识。处置：

1. `wos_run_status` 看 `stage` 与 `next`；
2. 若 `stage` 是拼写错误，用 `wos_records_update` 触发一次 `syncStage`（写一条无关状态即可让它重算）；
3. 仍不对就把 `run.json` 的 `stage` 报给用户，不要手工编辑账本——`records.md` 是它的只读视图，手改会与磁盘实际状态脱钩。

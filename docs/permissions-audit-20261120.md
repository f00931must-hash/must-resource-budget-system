# 經費系統權限整理與重整（2026-11-20）

狀態：獨立分支上的待審查版本。尚未合併 main、發布 Firebase 規則或部署附件 Worker。
基準：`dfed487e49ed1ed6a8df8886693bc976dd3b7b34`。不讀取、不修改正式經費紀錄；不需要資料搬移。

## 依據既有要求整理的角色表

| 角色 | 資料範圍 | 可以操作 |
|---|---|---|
| 一般老師（teacher / user） | 自己負責的使用紀錄、自己的領款與退款 | 新增、編輯金額/狀態/學期/科目/單號/備註、上傳/更換/移除附件、移至回收桶、確認領款、申報/追加退款 |
| 經費管理員（manager） | 所有人與全部批次 | 上述操作，加上變更負責老師、核對/解鎖、免附單據確認/撤銷、附件實體清理、回收桶還原、建立/修改批次、領款批次、活動分配、分筆付款、追加預支、確認退款 |
| 預支承辦人（advance） | 一般老師權限，加上自己的批次/活動分配 | 自己批次的建立與編輯、連結自己的既有預估、分筆給老師、確認對應款項退款；不可處理其他承辦人的批次或管理員核對 |

所有日常財務寫入要求帳號啟用。既有指定主帳號保留修復「自己帳號角色」的 bootstrap 例外，但停用帳號不能因此直接寫入財務資料。
一般老師可查看全部使用紀錄，維持原來查詢範圍；這次沒有改成只能查詢自己的資料，以免破壞現有畫面。
沒有新增協助同學的經費操作權限；附件 Worker 原本對 assistant 的限制仍保留。

「可以操作」和「怎麼維持帳目一致」分開處理：已核對的紀錄須先由管理員解鎖才能一般編輯；已連結預支的原分配金額透過追加/退款流程同步；尚有已領取分筆款項的活動不能直接整筆解除。這些是保留的業務條件，不是用權限不足取代操作說明。

## 已逐項對照的按鈕與寫入

| 畫面／動作 | 目前實際程式 | 資料寫入／新規則入口 | 老師／管理員 |
|---|---|---|---|
| 新增使用紀錄 | app-v120 `saveRecord`，經兩層 loader 組成 | expenseRecords create | 自己／所有人 |
| 修改金額、學期、科目、用途、備註、請購與核銷單號 | `saveRecord` | expenseUpdate → expenseCorrection / expenseForm | 自己／所有人 |
| 預估、請購中、核銷中、漢龍預支標記 | `saveRecord`＋app-v165-loader | expenseForm | 自己／所有人 |
| 新附件／更換附件／沿用原附件送出 | `uploadVoucherFile`＋`saveRecord` | Worker upload → expenseForm | 自己／所有人 |
| 不需附件申請／修改 | budget-no-voucher-request-v137 `saveRequestedRecord` | expenseWaiverRequest / expenseCorrection | 自己／所有人 |
| 管理員確認／撤銷免附 | budget-manager-waiver-click-v139；admin-clean-v140 | expenseWaiver | 禁止／允許 |
| 變更負責老師 | `changeExpenseOwner` | expenseOwner / expenseAccountingOwner ＋ auditLogs，同交易 | 禁止／允許 |
| 核對完成／解鎖 | manager-waiver-click `reviewOnce`；`unlockRecord` | expenseReview（核對含同交易 auditLogs） | 禁止／允許 |
| 老師移除附件連結 | `detachOwnVoucher` | expenseDetach | 自己／管理員有實體清理入口 |
| 管理員刪除附件／批次清理 | attachment-delete-v126 `markPurged` | Worker delete → expensePurge | 禁止／允許 |
| 使用紀錄刪除（10 天回收桶） | app-v128-loader 的 deleteRecord | expenseRecycle | 自己／所有人，須先解除預支連結 |
| 還原紀錄／到期清除 | trash-v128；trash-plan-restore-v128 | expenseRestore / delete | 禁止／允許 |
| 計畫、科目、預算挪用 | app-v120 savePlan/saveCategory/transfer | budgetPlans / budgetCategories | 讀取／管理 |
| 建立／修改預支批次、分次領款、刪除領款紀錄 | advance-v150 saveBatch/saveReceipt/deleteReceipt | advanceBatches | 承辦人自己的批次／管理員所有批次 |
| 活動連結既有預估 | advance-link-existing-v153 `saveLink` | 新增 advanceAllocations ＋ expenseUpdate → linkExistingEstimate | 承辦人自己／管理員所有人 |
| 解除活動分配／清理孤兒分配 | advance-delete-v151 `deleteAllocation` | allocationRemove ＋ expenseUnlink；金額不變 | 承辦人自己／管理員所有人 |
| 首次／追加「分配款項給老師」 | split-payout `addDialog` | 新增 advancePayouts ＋ allocationUpdate → payoutParentChange | 承辦人自己的活動／管理員所有活動 |
| 老師確認領取分筆款項 | split-payout `splitAction(receive)` | payoutReceive ＋同步父分配未領款額 | 自己／管理員可代辦 |
| 刪除尚未領取的分筆款項 | splitAction(remove) | payoutRemove ＋回補父分配 | 承辦人自己的活動／管理員所有活動 |
| 整筆／分筆退款申報、追加退款 | settlementAction(report)；splitAction(refund-report) | teacherRefundReport / payoutReport | 自己／管理員可代辦 |
| 確認收到退款 | settlementAction(receive)；splitAction(refund-receive) | 退款收訖＋expenseRefund，同交易；分筆另同步父分配 | 承辦人規定範圍／管理員所有人 |
| 追加預支 | advance-v150 `addAdvanceTopUp` | allocationTopUp ＋ expenseTopUp ＋ auditLogs，同交易 | 禁止／允許 |
| 舊紀錄的實際金額申請待審資料 | actualAdjustment 相容欄位 | expenseAdjustment；批准時同步 allocationAdjustmentSettlement | 本人申請／管理員審查；退款可取消待審 |
| Excel、核銷附件批次下載、會統摘要 | app-v120 downloadBudgetExcel/batchDownloadVouchers/reconciliation | 讀取＋管理員 auditLogs | 禁止／允許 |
| 提醒設定與手動通知 | reminder-v160 / window-v163 / email-v168 | reminderSettings / reminderLogs；通知 Worker | 禁止／允許 |

分配有兩層：「活動連結既有預估」和「把該筆金額分給不同老師」。這次文件與測試把兩者分開，避免再查錯流程。
歷史未載入的補丁檔（例如 admin-patch-v121、manager-usability-v136）沒有當成目前運行入口；原檔保留以利回溯。

## 修改的結構

1. `expenseRecords`、`advanceAllocations`、`advancePayouts` 各只保留一個 allow update，統一先檢查啟用帳號與 updatedBy/updatedAt，再用 changed keys 的互斥路由驗證操作。
2. 移除使用紀錄最後的通用放行規則及多段重複例外。非本次操作所需的角色判斷、get/getAfter 不再連續執行。
3. 保留跨文件同步條件：退款、追加、分筆款項父子表與活動解除必須一致；管理員也不靠跳過帳務一致性檢查來取得權限。
4. 首次新增 splitRefundTotal=0 不再和退款收訖混淆。分筆父表按新增／領款／刪除／退款選一條路徑，避免反覆驗證相同角色。
5. `budget-permissions.mjs` 統一目前寫入模組的角色判斷；啟用條件及主帳號例外和規則一致。
6. 舊紀錄缺少選填欄位、originalEstimatedAmount=null、categoryIds=null、refundConfirmedTotal=null 均按對應前端預設值驗證，不對正式資料進行補欄或批次修正。
7. 新附件 Worker v0.7.0 直接讀經費 users/email profile，取代另一份 GitHub 授權清單及 5 分鐘清單快取。保留舊同步端點供 Portal 相容，但附件授權不再依賴該清單。額外成本為每次附件請求讀一筆自己的帳號，不是全表讀取。
8. 通知 Worker v1.2.0 的手動管理員操作同樣改讀 users profile，不再另讀 GitHub 的 manager 名單；既有排程、收件人與發送邏輯保留，沒有實際發送任何測試訊息。
9. Worker 實體刪除限管理員、檔案對應紀錄的負責人或原上傳者；原上傳者可清理替換或儲存失敗的新附件。舊檔案不需要搬移。其他活動／公告／Portal 的授權程式保留。

沒有重新計算預算、重新對帳、修改金額公式、重寫正式紀錄、重設角色、增加付費 Firebase 服務或排程。

## 固定驗證與發布門檻

```sh
python scripts/test-permissions.py
node --test tests/budget-role-policy.test.mjs tests/budget-upload-policy.test.mjs tests/budget-notify-policy.test.mjs tests/budget-loader.test.mjs
```

- Java 21、Python、Node 22；runner 下載固定版本 Firestore emulator。
- 專案固定 `demo-attach`，地址固定 `127.0.0.1:18947`；不得從環境變數切換到正式 endpoint。若該 port 被占用，拒絕重用未知伺服器。
- 每份測試前只清空本機 demo emulator；不使用正式帳號、金鑰或實際經費資料。
- 有應允許與應拒絕測試，涵蓋老師、另一位老師、經費管理員、預支承辦人、停用帳號、舊欄位、原附件、免附、退款、分筆付款、追加、解除、還原與跨文件缺漏。
- 一部分測試直接執行真正的前端 saveRecord / settlementAction / splitAction，再透過測試用 SDK adapter 寫本機 emulator；DOM 和上傳回應是替身，不是登入正式網站測試。
- 額外測試兩層 app loader 的真實組合結果，保留私密附件路由和回收桶處理。
- 即使結果是 403，只要訊息或 emulator log 出現最大 1000 expressions，整套測試仍失敗，不把運算超標算成正確拒絕。
- `permissions.yml` 在 PR/重整分支跑檢查；Pages 部署工作必須先通過同一套檢查。
- `docs/permissions-validation-20261120.json` 保存本次本機結果及 rules blob。它不是正式環境驗證證明；之後以 CI 的最新 artifact 為準。

## 已知界線

- 沒有登入老師的正式帳號、讀取正式經費文件、測試正式寫入，或驗證目前 Firebase Console 裡已發布的版本。
- Worker 的權限與刪除判斷使用替身測試；沒有使用正式 Firebase ID token 或正式 GitHub 私密附件做遠端上傳、下載、刪除測試。Worker 環境設定及實際部署版本仍需在切換時確認。
- 尚未進行完整瀏覽器的人工操作回歸。實際 handler＋模擬 DOM/SDK 測試不等於完整瀏覽器驗證，也不能稱為所有可能情境 100% 不會失敗。
- 另執行既有 reconciliation.test.mjs，發現「作廢及排除類別不計入」已有 1 項失敗（2000 vs 500）。該測試及 budget-reconciliation.js 均與基準完全相同，本次沒有改對帳算法；此既有問題另列，不把它混入權限重整的成功宣稱。

## 待審查版切換與回復

先審查本分支與測試結果，不把待審查版本直接貼到正式系統。
若安排切換：保留目前 Firebase 完整規則和 Worker 版本／環境設定 → 發布本分支完整規則 → 部署附件 v0.7.0 與通知 v1.2.0 Worker（沿用既有 bindings）→ 合併前端，通過 CI 後由 Pages 發布 → Ctrl+F5 並確認實際操作結果。
不建立測試經費紀錄。若要做正式寫入驗證，應由使用者執行本來就要處理的業務操作，而非額外造資料。
需回復時使用切換前保存的規則、Worker 和前端版本；本次沒有資料遷移，無須回寫金額或還原資料庫快照。

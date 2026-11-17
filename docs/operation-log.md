# 經費操作紀錄
僅記錄啟用後的寫入；不回填既有資料，不啟用舊 auditLogs 的到期刪除。
正式部署請先準備已啟用帳單的 Firebase 專案，由專案管理者部署 functions:budget-operation-log，並在 budgetOperationLogs 集合群組的 expiresAt 欄位設定 Firestore TTL。只允許經費管理員瀏覽紀錄；瀏覽不開監聽。
正式 Firestore 規則若跟原始碼不同，請只將 budgetOperationLogs 的 match 區塊加入目前生效規則，避免覆寫無關的權限修正。完成後再上線 UI。由單筆事件識別碼防止事件重送造成重複紀錄。
未取得可驗證身分的事件只顯示事件提供的識別碼或未取得身分；不把紀錄負責人當作操作人。

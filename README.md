# must-resource-budget-system

明新科技大學資源教室經費管理系統。

## V0.1 已建立

- Google Authentication 登入
- 經費管理員 / 經費使用者兩種角色
- 經費科目與額度管理
- 老師使用紀錄登錄
- 核銷憑證共用資料夾歸檔勾選
- 經費總覽與剩餘額度
- 額度調整 Audit Log
- Firestore Rules 基礎權限控制

## 首次設定

1. Firebase Authentication 啟用 Google。
2. 建立 Cloud Firestore。
3. 將 repository 的 `firestore.rules` 貼到 Firebase Console → Firestore → Rules 並發布。
4. 在 Firestore 建立 `users` collection，第一位管理員 document ID 使用其 Google 登入 email（全小寫），欄位：
   - `name`: string
   - `role`: `manager`
   - `enabled`: true
5. GitHub repository → Settings → Pages → Deploy from a branch → `main` / `(root)`。

## 權限

- `manager`：可管理經費科目與額度、查看全部使用紀錄。
- `user`：只能新增與修改自己的使用紀錄。

> 學校正式請購、核銷仍使用校方既有系統；本系統定位為資源教室內部經費控管與追蹤。

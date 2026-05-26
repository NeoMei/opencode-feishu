# 发布流程规范

## 版本号管理

每次发布到 GitHub 必须遵循以下流程：

1. **修改版本号**
   - 编辑 `package.json` 中的 `version` 字段
   - 格式：`主版本.次版本.修订版本`（如 `0.3.0`）

2. **提交代码**
   ```bash
   git add .
   git commit -m "feat: xxx"  # 或 fix:, docs: 等
   git push origin main
   ```

3. **打 Tag**
   ```bash
   git tag v0.3.0  # 必须与 package.json 中的版本号一致
   git push origin v0.3.0
   ```

4. **自动发布**
   - GitHub Actions 检测到 tag 推送后会自动：
     - 运行测试
     - 构建项目
     - 发布到 npm

## 注意事项

- **必须打 tag**：GitHub Actions 工作流监听的是 tag 推送事件，不是 main 分支推送
- **Tag 格式**：必须以 `v` 开头，后跟版本号（如 `v0.3.0`）
- **版本号一致性**：tag 版本号必须与 `package.json` 中的版本号完全一致
- **不要跳过 tag**：即使只是小修改，也要打 tag 才能触发自动发布

## 检查清单

发布前确认：
- [ ] `package.json` 版本号已更新
- [ ] 代码已提交到 main 分支
- [ ] 已打 tag（`git tag vX.X.X`）
- [ ] 已推送 tag（`git push origin vX.X.X`）
- [ ] GitHub Actions 运行成功
- [ ] npm 版本已更新

## 历史版本

- v0.3.0 - feat: 添加 thinkingLanguage 配置，支持中文/英文思考切换
- v0.2.11 - fix: 修复权限卡片竞争条件
- v0.2.10 - fix: Windows 跨平台兼容性
- v0.2.9 - 基础功能稳定版

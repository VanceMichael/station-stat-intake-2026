# 共享统计申请的配额取数与分项交付

这里的资料由本地来源模拟器提供，编号、参与方和历史业务记录全部为合成数据。运行环境为 Node.js 22.23.4，监听地址默认为 `127.0.0.1:8700`，可用 `PORT` 调整端口。

```sh
npm run source
```

另开终端运行 `npm test` 可检查来源契约。测试以独立临时端口启动来源。

业务记录各版和取件字段见 [资料格式](source/formats.md)。`POST /control?edition=r2` 模拟业务方更换当期资料，`r3` 表示后续一期。单独重启服务可以重置来源侧会话。

## 分项取数台

`desk/` 是联络员的取数台账：提交分项请求、追站点回执、按许可版本与发布门槛交付合作方材料，并逐段区分尚无结果、未达门槛、主动取消、已无权限四类去向。规则与命令见 [取数台说明](desk/README.md)，常用入口：

```sh
npm run desk -- sync all          # 对账来源资料流
npm run desk -- view --request R  # 分项与段去向
npm run desk -- ledger --station B
```

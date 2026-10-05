@../pi 是pi agent的源代码, pi最近更新了，引入了一个新的pi-durable框架。
首先你要分析该框架，本项目是要实现一个类似hermes agent(项目在 @../hermes-agent)的功能。hermes对我来说太重了，所以我想用pi-durable来实现一个轻量级的hermes agent。
项目使用node typescript开发，项目提供一个无需认证的管理页面，用来配置模型等等参数。项目不引入任何配置文件，会话以及配置全部保存到sqlite数据库中。agent运行要考虑沙盒实现，比如参考使用anthropic的sandbox-runtime等方案，来限制agent的文件读取修改权限，同时网络也是一样。
项目需要支持各种对话渠道，比如weixin,企业微信，qq等，这里的实现可以调研hermes现有的，看看能不能直接复用。
一期目标，完整的agent能力，沙盒，终端渠道对话。同时设计上要保证扩展性。
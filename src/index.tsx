import { Context, Random, Schema, Session } from "koishi";
import {} from "koishi-plugin-adapter-onebot";
import {} from "koishi-plugin-cache-database";

export const name = "captcha";

export const inject = {
  required: ["cache"],
};

export interface Config {
  maxAge: number;
  // 白名单群号配置
  guildIds: string[];
  attempts: number;
}

function isUndefined(value: any): boolean {
  return typeof value === "undefined";
}

let timerCounter = 0; // 用于生成唯一的定时器 ID
const timers = {}; // 用于存储定时器对象

function createTimer(callback: Function, delay: number): number {
  const timerId = ++timerCounter; // 生成唯一的定时器 ID
  const timeout = setTimeout(() => {
    callback();
    delete timers[timerId]; // 定时器触发后从对象中删除
  }, delay);

  timers[timerId] = timeout; // 存储定时器对象
  return timerId;
}

function clearTimer(timerId: number) {
  const timeout = timers[timerId];
  if (timeout) {
    clearTimeout(timeout); // 清除定时器
    delete timers[timerId]; // 从对象中删除
  }
}

export const Config: Schema<Config> = Schema.object({
  maxAge: Schema.number()
    .default(1000 * 60 * 3)
    .description("验证码有效时间(毫秒)"),
  attempts: Schema.number()
    .default(3)
    .description("最大尝试次数")
    .min(1)
    .max(9),
  guildIds: Schema.array(String)
    .description("只有添加在白名单的群号才会生效")
    .role("table")
    .default([]),
});

interface CaptchaCache {
  attempts: number;
  result: number;
  createdAt: number;
  timerId: number;
}

export function apply(ctx: Context, config: Config) {
  // write your plugin here

  // TODO 未完成逻辑：超时后踢出群员（难点：无法保存计时器Id/销毁计时器的函数到cache）

  ctx.on("guild-member-added", async (session: Session) => {
    const { userId, guildId, type } = session;
    const { guildIds, maxAge, attempts } = config;

    const a = Random.int(1, 100);
    const b = Random.int(1, 100);

    if (guildIds.indexOf(guildId) === -1) return;
    console.log(guildId, userId, type);

    try {
      await session.send(
        <>
          欢迎 <at id={userId} /> 加入本群！请完成验证群验证。
          <br />
          {a} + {b} = ?
          <br />
          (tips: 你只有{attempts}次机会，超过{attempts}次将被移出本群)
        </>
      );

      const value: CaptchaCache = {
        attempts: 0,
        result: a + b,
        createdAt: Date.now(),
        timerId: createTimer(() => {
          ctx.logger.info("验证码超时，移出群 " + userId);
          session.send(
            <>
              <at id={userId} />
              验证码超时，你已被移出本群
            </>
          );
          session.onebot.setGroupKick(guildId, userId, false);
        }, maxAge),
      };
      await ctx.cache.set("default", `captcha:${userId}`, value, maxAge);
    } catch (error) {
      ctx.logger.error(error);
      session.send("入群验证码插件出错, 请联系管理员");
    }
  });

  ctx.on("message-created", async (session: Session) => {
    const { userId, guildId, messageId } = session;
    const message = session.event.message;
    const { content } = message;
    const { guildIds, attempts } = config;

    if (guildIds.indexOf(guildId) === -1) return;

    let captchaCache: CaptchaCache | undefined;
    try {
      captchaCache = await ctx.cache.get("default", `captcha:${userId}`);
      await ctx.cache.delete("default", `captcha:${userId}`);
    } catch (error) {
      ctx.logger.error(error);
    }

    if (
      isUndefined(guildId) ||
      isUndefined(content) ||
      isUndefined(captchaCache)
    )
      return;

    if (captchaCache.result === Number(content)) {
      clearTimer(captchaCache.timerId);
      await session.send(
        <>
          <at id={userId}></at>验证成功，欢迎你的到来~
          <br />
          新人先看群公告
        </>
      );
      await ctx.cache.delete("default", `captcha:${userId}`);
    } else {
      // 撤回未验证群员的消息

      captchaCache.attempts++;

      if (captchaCache.attempts >= attempts) {
        // 验证超过上限，移除本群
        clearTimer(captchaCache.timerId);
        await session.send(
          <>
            <at id={userId} />
            验证失败，你已被移出本群。
          </>
        );

        session.onebot?.setGroupKick(guildId, userId, false);
      } else {
        const maxAge: number = Date.now() - captchaCache.createdAt;

        Promise.all([
          ctx.cache.set("default", `captcha:${userId}`, captchaCache, maxAge),
          session.send(
            <>
              <at id={userId} /> 答案错误,你还有
              {attempts - captchaCache.attempts}次机会
            </>
          ),
          session.onebot.deleteMsg(messageId),
        ]);
      }
    }
  });
}
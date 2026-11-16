// Endpoints are overridable only so the tests can point the client at a fake Discord.
export const config = {
  apiBase: 'https://discord.com/api/v10',
  gatewayUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
  gatewayQuery: '/?v=10&encoding=json',
  reconnectBase: 1000,
  maxReconnectBackoff: 30000,
  voiceTimeout: 20000,
};

export const SNOWFLAKE = /^[0-9]{1,20}$/;
export const isSnowflake = (v) => typeof v === 'string' && SNOWFLAKE.test(v);

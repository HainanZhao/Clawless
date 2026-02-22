import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const useJson = process.env.LOG_FORMAT === 'json';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  transport: useJson
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
          singleLine: true,
        },
      },
});

export default logger;

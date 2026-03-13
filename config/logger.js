'use strict';
/**
 * config/logger.js
 * Structured logger using winston + daily-rotate-file.
 */
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const { combine, timestamp, printf, colorize, errors } = format;
const logFormat = printf(({ level, message, timestamp, stack }) =>
  `${timestamp} [${level}]: ${stack || message}`
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), logFormat),
  transports: [
    new transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat),
    }),
    new transports.DailyRotateFile({
      filename: 'logs/combined-%DATE%.log', datePattern: 'YYYY-MM-DD',
      maxFiles: '14d', zippedArchive: true,
    }),
    new transports.DailyRotateFile({
      filename: 'logs/error-%DATE%.log', datePattern: 'YYYY-MM-DD',
      level: 'error', maxFiles: '30d', zippedArchive: true,
    }),
  ],
});

module.exports = logger;

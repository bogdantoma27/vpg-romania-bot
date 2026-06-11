'use strict';

const config = {
  superligaScheduleChannelId:  process.env.SUPERLIGA_SCHEDULE_CHANNEL_ID  || '',
  superligaResultsChannelId:   process.env.SUPERLIGA_RESULTS_CHANNEL_ID   || '',
  superligaClasamentChannelId: process.env.SUPERLIGA_CLASAMENT_CHANNEL_ID || '',
  totwChannelId:               process.env.TOTW_CHANNEL_ID                || '',
  totsChannelId:               process.env.TOTS_CHANNEL_ID                || '',
  transfersChannelId:          process.env.TRANSFERS_CHANNEL_ID           || '',
  clubLimitChannelId:          process.env.TRANSFERS_CLUB_LIMIT_CHANNEL_ID || '',
};

module.exports = { config };

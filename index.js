import { DeliverooAgentCoop } from './cooperation/agent_coop.js';
import { config } from './config.js';

const agent1 = new DeliverooAgentCoop(config.HOST, config.TOKEN1);
const agent2 = new DeliverooAgentCoop(config.HOST, config.TOKEN2);

agent1.start();
agent2.start();

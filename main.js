import { DeliverooAgent } from './agent.js';
import { config } from './config.js';

const A1 = new DeliverooAgent(config.HOST, config.TOKEN1, true, false);
A1.start();

const A2 = new DeliverooAgent(config.HOST, config.TOKEN2, true, false); 
A2.start();

// const A3 = new DeliverooAgent(config.HOST, config.TOKEN3, true, false); 
// A3.start();

// const A4 = new DeliverooAgent(config.HOST, config.TOKEN4, false, true);  
// A4.start();
    
// const A5 = new DeliverooAgent(config.HOST, config.TOKEN5, false, true);  
// A5.start();
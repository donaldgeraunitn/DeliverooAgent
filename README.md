<p align='center'>
    <h1 align="center">Autonomous Software Agents Project</h1>
    <div align="center">
        <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black" alt="JavaScript"/>
        <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white" alt="Node.js"/>
        <img src="https://img.shields.io/badge/PDDL-005F8F?style=flat&logo=prolog&logoColor=white" alt="PDDL"/>
    </div>
    <p align='center'>
    This project was developed for the Autonomous Software Agents course at the University of Trento during the 2024/2025 academic year.<br/><br/>
    by<br/>
    [Your Name]<br/>
    [Partner Name]<br/>
    </p>   
</p>

The goal is to implement an autonomous agent using the **Belief-Desire-Intention (BDI)** model, which allows the agent to perceive the environment, form goals, plan actions, and continuously adapt to dynamic conditions.

The agents operate in a simulated game environment where they must **pick up and deliver parcels efficiently**, as shown in the examples below.

In addition, the project consists of two parts:

* **Single Agent**: A standalone agent that independently explores the environment, updates its beliefs, and makes decisions to fulfill its goals using a combination of PDDL deliberative planning and reactive A*-based strategies.

    ![Example](video_example_agents.gif)

* **Multi-Agent**: A system of **two cooperating agents** that share information, coordinate strategies, and divide tasks to complete deliveries more effectively. The system features intelligent role assignment and handover coordination for corridor-like maps.

    ![Example](video_example_multiagents.gif)

Performance is evaluated across multiple game layouts. Results and insights are included in the [report](docs/report.pdf) under the *Evaluation and Results* section.

The environment is based on the [Deliveroo.js](https://github.com/unitn-ASA/DeliverooAgent.js) simulation framework.

## 🗂️ Project Structure

Here's a description of the project structure.

```
.
├── README.md
├── config.js                  # Configuration and agent tokens
├── main.js                    # Entry point for launching agents
├── package.json
├── package-lock.json
├── docs/
│   ├── report.pdf             # Formal report
│   └── presentation.pdf       # Project presentation slides
└── src/
    ├── agent.js               # Agent initialization and lifecycle
    ├── BDI - plans/           # Plan implementations (BDI architecture)
    │   ├── deliver.js         # Parcel delivery with intelligent detours
    │   ├── explore.js         # Map exploration strategy
    │   ├── handover.js        # Collector/Courier coordination for corridors
    │   ├── intention.js       # Intention execution and monitoring
    │   ├── pathfinding.js     # A* pathfinding with collision avoidance
    │   ├── pickup.js          # Parcel selection and pickup logic
    │   └── plan.js            # Base plan class with common functionality
    ├── Beliefs/               # Agent knowledge representation
    │   ├── beliefs.js         # Central belief management
    │   ├── environment.js     # Map representation and zone partitioning
    │   └── tile.js            # Tile entity with neighbor tracking
    ├── Collaboration/         # Multi-agent coordination
    │   ├── coordination.js    # Partner communication and handshake
    │   ├── handover_detector.js # Bottleneck detection for handover mode
    │   └── message.js         # Message protocol definitions
    ├── PDDL/                  # PDDL deliberative planning
    │   ├── pddl_plan.js       # PDDL solver integration
    │   └── domain.pddl        # PDDL domain definition
    └── Utils/                 # Utility functions and helpers
        ├── banlist.js         # Temporal banning for failed actions
        └── utils.js           # Distance calculations and constants
```

## ✨ Key Features

Our implementation includes several advanced features for robust autonomous operation:

* **Adaptive Planning**: Dynamic switching between PDDL deliberative planning and reactive A*-based plans depending on problem complexity
* **Smart Detour Optimization**: Utility-based decision making with hysteresis to prevent oscillation between delivery and detour states
* **Intelligent Handover Mode**: Automatic detection of corridor maps with role assignment (Collector/Courier) for optimal coordination
* **Proximity Filtering**: Agents respect each other's proximity to parcels, avoiding unnecessary competition
* **Batch Collection**: Handover collector gathers multiple nearby parcels before delivery for improved efficiency
* **Robust Recovery**: Graceful degradation with bypass mechanisms when optimal strategies are blocked
* **Zone Partitioning**: Multi-agent map division for distributed exploration

## 🚀 Installation & Usage

To try the autonomous agents, follow these steps:

1. **Clone the repository**:

   ```bash
   git clone https://github.com/donaldgeraunitn/DeliverooAgent.git
   ```

2. **Navigate to the project directory**:

   ```bash
   cd DeliverooAgent
   ```

3. **Install dependencies**:

   ```bash
   npm install
   ```

4. **Configure agent tokens** in `config.js`:

   ```javascript
   export const config = {
       HOST: 'http://localhost:8080',
       TOKEN1: 'your-agent-token-1',
       TOKEN2: 'your-agent-token-2'  // For multi-agent mode
   };
   ```

5. **Start the project**:

   ```bash
   npm start
   ```


## 📚 Additional Information

If you want more information about the technical aspects see the [final report](docs/report.pdf).

## 📄 License
This project is developed for academic purposes at the University of Trento.

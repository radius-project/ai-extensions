# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Software engineers using the GitHub Copilot CLI who need to model, visualize, and deploy Radius applications (containerized apps, databases, message brokers) directly from their terminal workflow.

## Product Purpose
To provide an interactive Canvas and AI skills within the Copilot CLI that help developers author application definitions (`app.bicep`), visualize the application graph, and manage cloud deployment environments (Azure/AWS) without leaving the assistant.

## Positioning
A deeply integrated, native-feeling Radius extension for GitHub Copilot CLI that bridges the gap between conversational AI and interactive application modeling/visualization.

## Operating Context
Runs inside the GitHub Copilot CLI native application as a web-based Canvas extension (`adapters/canvas`). Heavily relies on the terminal assistant workflow and side-panel visual rendering.

## Capabilities and Constraints
- Must integrate tightly with the Copilot host app's styling, specifically utilizing injected semantic theme tokens for light/dark mode and adhering to host layout constraints.
- Graph visualization relies on React Flow.
- Follows Radius application schemas and OIDC federation for cloud credentials.
- Purely frontend UI for the canvas; business logic and orchestration are handled by the Copilot CLI host and backend skills.

## Evidence on Hand
- Existing `.github/skills/radius-app-bicep/SKILL.md` defining the application model.
- Existing canvas adapter source (`adapters/canvas/src`) handling HTML/CSS page rendering, React Flow client JS, and Copilot theme integration.

## Product Principles
- **Host-Native Feel:** The UI must look and feel like an integral part of the Copilot CLI, respecting its design tokens and modes.
- **Visual Clarity:** Application graphs and diffs must be immediately readable, minimizing cognitive load for developers inspecting complex architectures.
- **Workflow Continuity:** The canvas should complement the chat, offering interactive visual tools right when the conversational flow requires them.


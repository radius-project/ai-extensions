import { registerRoute } from "@kinvolk/headlamp-plugin/lib";
import { HeadlampFrame } from "./peer";

function Baseline() {
  return (
    <HeadlampFrame>
      <button
        onClick={() => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = "/assets/GraphView-Cdd0UtY8.css";
          document.head.append(link);
        }}
      >
        Load Headlamp GraphView stylesheet
      </button>
      <button
        onClick={() => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = "/plugins/radius-headlamp-consumer/candidate-styles.css";
          document.head.append(link);
        }}
      >
        Load candidate stylesheet
      </button>
    </HeadlampFrame>
  );
}

registerRoute({
  path: "/radius-graph-compatibility",
  sidebar: null,
  useClusterURL: false,
  noAuthRequired: true,
  component: Baseline
});

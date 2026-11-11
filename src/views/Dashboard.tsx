import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Download, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "../context/AppContext";
import { AgentControlSetupCard } from "../components/AgentControlSetupCard";
import { BackupStatusLink } from "../components/BackupStatusLink";

export function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tools, projects, managedSkills, openSkillDetailById } = useApp();

  const enabledAgents = useMemo(
    () => tools.filter((tool) => tool.installed && tool.enabled),
    [tools]
  );

  const totalSkills = managedSkills.length;
  const syncedSkills = useMemo(
    () => managedSkills.filter((s) => s.targets.length > 0).length,
    [managedSkills]
  );

  const divergedCount = useMemo(
    () => projects.reduce((acc, p) => acc + p.sync_health.diverged, 0),
    [projects]
  );

  const recentSkills = useMemo(
    () => [...managedSkills].sort((a, b) => b.updated_at - a.updated_at).slice(0, 5),
    [managedSkills]
  );

  const coverageLabel = totalSkills === 0 ? "0" : `${syncedSkills}/${totalSkills}`;
  const toolName = (key: string) => tools.find((tool) => tool.key === key)?.display_name ?? key;
  const sourceLabel = (sourceType: string) => (sourceType === "skillssh" ? "skills.sh" : sourceType);

  return (
    <div className="app-page app-page-narrow">
      <div className="app-page-header flex items-start justify-between gap-4">
        <div>
          <h1 className="app-page-title">{t("dashboard.greeting")}</h1>
          <p className="app-page-subtitle text-tertiary">
            {t("dashboard.summary", {
              skills: totalSkills,
              agents: enabledAgents.length,
              projects: projects.length,
            })}
          </p>
        </div>
        <BackupStatusLink refreshKey={managedSkills} className="-mr-2.5 shrink-0" />
      </div>

      <AgentControlSetupCard />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3.5">
        {[
          { title: t("dashboard.librarySkills"), value: String(totalSkills), warning: false },
          // Diverged project copies are the one state worth flagging here.
          { title: t("dashboard.syncCoverage"), value: coverageLabel, warning: divergedCount > 0 },
          { title: t("dashboard.connectedAgents"), value: String(enabledAgents.length), warning: false },
        ].map((stat) => (
          <div key={stat.title} className="app-panel px-4 py-3.5">
            <p className="app-section-title mb-1.5">{stat.title}</p>
            <p className="flex items-center gap-1.5 text-[17px] font-semibold leading-none text-primary tabular-nums">
              {stat.value}
              {stat.warning && (
                <AlertTriangle
                  className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
                  aria-label={t("dashboard.divergedWarning", { count: divergedCount })}
                />
              )}
            </p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => navigate("/install?tab=local")}
          className="app-button-primary flex-1"
        >
          <Download className="w-4 h-4" />
          {t("dashboard.scanImport")}
        </button>
        <button
          onClick={() => navigate("/install")}
          className="app-button-secondary flex-1"
        >
          <Plus className="w-4 h-4 text-tertiary" />
          {t("dashboard.installNew")}
        </button>
      </div>

      {/* Recent skills */}
      {recentSkills.length > 0 && (
        <div>
          <h2 className="app-section-title mb-2.5">
            {t("dashboard.recentActivity")}
          </h2>
          <div className="app-panel overflow-hidden divide-y divide-border-subtle">
            {recentSkills.map((skill) => (
              <div
                key={skill.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  openSkillDetailById(skill.id);
                  navigate("/my-skills");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    openSkillDetailById(skill.id);
                    navigate("/my-skills");
                  }
                }}
                className="flex items-center justify-between px-3.5 py-2.5 hover:bg-surface-hover transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-6 h-6 rounded-md flex items-center justify-center text-[13px] font-semibold bg-accent-bg text-accent-light shrink-0">
                    {skill.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <h4 className="text-[13px] text-secondary font-medium flex items-center gap-1.5">
                      {skill.name}
                      <span className="text-[11px] px-1.5 py-px rounded-full bg-surface-hover text-muted border border-border font-normal">
                        {sourceLabel(skill.source_type)}
                      </span>
                    </h4>
                    <p className="text-[13px] text-muted mt-px">
                      {skill.targets.length > 0
                        ? t("dashboard.syncedTo", { agents: skill.targets.map((target) => toolName(target.tool)).join(", ") })
                        : t("dashboard.notSynced")}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

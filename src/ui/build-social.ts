import { ic } from "../icons";
import { t } from "../i18n";

export function buildSocialPane(): string {
  return `<div class="wp-pane" data-p="so">
                  <div class="wp-group"><div class="wp-legend">Snackers HQ</div>
                      <a class="wp-btn primary" target="_blank" rel="noopener" href="https://discord.gg/filian">${ic("discord")}Snackers HQ — Discord</a>
                      <a class="wp-btn primary" target="_blank" rel="noopener" href="https://discord.gg/snackersru">${ic("discord")}Snackers RU — Discord</a>
                      <a class="wp-btn" target="_blank" rel="noopener" href="https://x.com/THE_W4LL_">${ic("xcom")}The Wall — X</a>
                      <a class="wp-btn" target="_blank" rel="noopener" href="https://www.reddit.com/r/THE_WALL_/">${ic("reddit")}r/THE_WALL_</a>
                  </div>
                  <div class="wp-group"><div class="wp-legend">VAI_PROG</div>
                      <a class="wp-btn" target="_blank" href="https://github.com/Vadim-Khristenko">${ic("github")}GitHub — VAI_PROG</a>
                      <a class="wp-btn" target="_blank" href="https://x.com/VAI_PROG">${ic("xcom")}x.com/VAI_PROG</a>
                  </div>
                  <div class="wp-group"><div class="wp-legend">Cloud</div>
                      <div style="font-size:11px;margin-bottom:4px">Quality / Качество:</div>
                      <select id="snapshot-quality" class="wp-input" style="font:11px sans-serif">
                          <option value="low">Low — 1500×1050 · ~30 tiles · fastest</option>
                          <option value="medium">Medium — 3000×2100 · ~108 tiles</option>
                          <option value="high" selected>High — 6000×4200 · ~408 tiles · best</option>
                      </select>
                      <button class="wp-btn" id="btn-snapshot">${ic("dl")}${t("snapshot")}</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">My Discord guilds</div>
                      <div class="wp-list" id="social-guilds"><div style="padding:6px">${t("syncing")}</div></div>
                  </div>
              </div>`;
}

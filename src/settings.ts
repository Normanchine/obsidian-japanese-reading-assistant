import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type JapaneseReadingAssistantPlugin from "./main";
import type { OcrProviderKind, ProviderKind, TriggerModifier } from "./types";

const PROVIDER_LABELS: Record<ProviderKind, string> = {
  deepseek: "DeepSeek API（云端）",
  ollama: "Ollama（本地 / 自定义地址）",
};

const MODIFIER_LABELS: Record<TriggerModifier, string> = {
  none: "不需要按键",
  ctrl: "按住 Ctrl",
  alt: "按住 Alt",
  shift: "按住 Shift",
};

const OCR_PROVIDER_LABELS: Record<OcrProviderKind, string> = {
  paddle: "PP-OCRv5（本机 CPU，推荐）",
  ollama: "Ollama 视觉模型（兼容模式）",
};

export class JapaneseReadingSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: JapaneseReadingAssistantPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("jra-settings");
    containerEl.createEl("h2", { text: "日语阅读助手" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "固定执行日语 → 简体中文。划词返回简译，划句返回译文、结构主干和最多 3 个关键点。",
    });

    this.renderProviderSection(containerEl);
    this.renderBehaviorSection(containerEl);
    this.renderMaintenanceSection(containerEl);
  }

  private renderProviderSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "模型服务" });

    new Setting(containerEl)
      .setName("服务来源")
      .setDesc(
        this.plugin.settings.provider === "deepseek"
          ? "选中文字会发送到 DeepSeek。"
          : "请求发往你填写的 Ollama 地址；127.0.0.1 表示当前设备。",
      )
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(PROVIDER_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value as ProviderKind;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.provider === "deepseek") {
      this.renderDeepSeekSettings(containerEl);
    } else {
      this.renderOllamaSettings(containerEl);
    }
    this.renderPdfOcrSettings(containerEl);

    new Setting(containerEl)
      .setName("测试当前模型")
      .setDesc(
        this.plugin.settings.provider === "deepseek"
          ? "会向 DeepSeek 发送一次很短的“猫”查词请求，可能产生极少量费用。"
          : "会让当前 Ollama 模型解析一次“猫”，首次载入模型可能较慢。",
      )
      .addButton((button) => {
        button.setButtonText("测试").onClick(async () => {
          button.setDisabled(true).setButtonText("测试中…");
          try {
            const translation = await this.plugin.testCurrentProvider();
            new Notice(`连接成功：猫 → ${translation}`, 5000);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(message, 7000);
          } finally {
            button.setDisabled(false).setButtonText("测试");
          }
        });
      });
  }

  private renderDeepSeekSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("API Key")
      .setDesc(
        "保存在 Obsidian Secret Storage 中；Obsidian 1.11.5+ 使用操作系统能力进行静态加密。",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-…")
          .setValue(this.plugin.settings.deepseekApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepseekApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("API 地址")
      .setDesc("默认地址会自动拼接 /chat/completions。")
      .addText((text) => {
        text
          .setPlaceholder("https://api.deepseek.com")
          .setValue(this.plugin.settings.deepseekBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.deepseekBaseUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("模型")
      .setDesc("默认使用速度更快的 deepseek-v4-flash。")
      .addText((text) => {
        text
          .setPlaceholder("deepseek-v4-flash")
          .setValue(this.plugin.settings.deepseekModel)
          .onChange(async (value) => {
            this.plugin.settings.deepseekModel = value.trim();
            await this.plugin.saveSettings();
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("refresh-cw")
          .setTooltip("读取可用模型")
          .onClick(async () => {
            button.setDisabled(true);
            try {
              const models = await this.plugin.refreshProviderModels();
              new Notice(
                models.length > 0
                  ? `可用模型：${models.join("、")}`
                  : "没有读取到可用模型。",
                7000,
              );
            } catch (error) {
              new Notice(
                error instanceof Error ? error.message : String(error),
                7000,
              );
            } finally {
              button.setDisabled(false);
            }
          });
      });
  }

  private renderOllamaSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Ollama 地址")
      .setDesc(
        "电脑本机默认是 http://127.0.0.1:11434；手机连接电脑时要填写电脑的局域网地址。",
      )
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:11434")
          .setValue(this.plugin.settings.ollamaBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.ollamaBaseUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Ollama 模型")
      .setDesc("填写已安装并支持文本生成的模型。")
      .addText((text) => {
        text
          .setPlaceholder("qwen2.5:7b")
          .setValue(this.plugin.settings.ollamaModel)
          .onChange(async (value) => {
            this.plugin.settings.ollamaModel = value.trim();
            await this.plugin.saveSettings();
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("refresh-cw")
          .setTooltip("检测已安装模型")
          .onClick(async () => {
            button.setDisabled(true);
            try {
              const models = await this.plugin.refreshProviderModels();
              if (models.length === 0) {
                new Notice("Ollama 已连接，但没有发现已安装模型。", 6000);
              } else {
                const current = this.plugin.settings.ollamaModel;
                const suffix = models.includes(current)
                  ? ""
                  : "；当前填写的模型不在列表中，请手动选择文本生成模型";
                new Notice(`已安装：${models.join("、")}${suffix}`, 7000);
              }
            } catch (error) {
              new Notice(
                error instanceof Error ? error.message : String(error),
                7000,
              );
            } finally {
              button.setDisabled(false);
            }
          });
      });
  }

  private renderPdfOcrSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("PDF OCR 引擎")
      .setDesc(
        "PP-OCRv5 只识别框选图像中的文字，随后再交给上方选定的翻译/解析模型；它不占用 Ollama 的显存。",
      )
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(OCR_PROVIDER_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(this.plugin.settings.ocrProvider)
          .onChange(async (value) => {
            this.plugin.settings.ocrProvider = value as OcrProviderKind;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.ocrProvider === "paddle") {
      new Setting(containerEl)
        .setName("PP-OCR 本地地址")
        .setDesc("服务已部署在本机；通常不需要修改。若服务未启动，PDF OCR 会提示连接失败。")
        .addText((text) => {
          text
            .setPlaceholder("http://127.0.0.1:7861")
            .setValue(this.plugin.settings.paddleOcrBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.paddleOcrBaseUrl = value.trim();
              await this.plugin.saveSettings();
            });
        });
      return;
    }

    new Setting(containerEl)
      .setName("Ollama OCR 模型")
      .setDesc("兼容视觉模型。仅在你自行安装了视觉 OCR 模型时使用。")
      .addText((text) => {
        text
          .setPlaceholder("视觉 OCR 模型名")
          .setValue(this.plugin.settings.ocrOllamaModel)
          .onChange(async (value) => {
            this.plugin.settings.ocrOllamaModel = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }

  private renderBehaviorSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "划选行为" });

    new Setting(containerEl)
      .setName("划选后自动查询")
      .setDesc(
        "开启后，选区稳定时直接请求模型；关闭后编辑模式仍可使用右键菜单和命令。",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoTrigger)
          .onChange(async (value) => {
            this.plugin.settings.autoTrigger = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("自动查询触发键")
      .setDesc(
        "只作用于可选文字，默认 Ctrl；PDF OCR 固定使用 Alt+左键拖框，不受此项影响。",
      )
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(MODIFIER_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(this.plugin.settings.triggerModifier)
          .onChange(async (value) => {
            this.plugin.settings.triggerModifier = value as TriggerModifier;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("触发延迟")
      .setDesc("等选区稳定后再发请求，避免拖动过程中重复调用。")
      .addSlider((slider) => {
        slider
          .setLimits(150, 800, 50)
          .setValue(this.plugin.settings.triggerDelayMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.triggerDelayMs = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("最大选区长度")
      .setDesc("超过此字符数时不发送，避免误选整页。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "20";
        text.inputEl.max = "2000";
        text
          .setValue(String(this.plugin.settings.maxSelectionCharacters))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed)) {
              this.plugin.settings.maxSelectionCharacters = Math.max(
                20,
                Math.min(2000, parsed),
              );
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("请求超时")
      .setDesc("Ollama 第一次加载模型时可能需要更久。")
      .addSlider((slider) => {
        slider
          .setLimits(15, 120, 5)
          .setValue(this.plugin.settings.requestTimeoutSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.requestTimeoutSeconds = value;
            await this.plugin.saveSettings();
          });
      });
  }

  private renderMaintenanceSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "缓存与隐私" });
    const privacy = containerEl.createDiv({ cls: "jra-settings__privacy" });
    privacy.createEl("strong", { text: "发送范围" });
    privacy.createEl("p", {
      text: "插件只发送当前选中的文字，或你主动框选的 PDF 图片，及固定提示词；不会发送笔记名、路径、Vault 信息或全文。图片不写入 vault，OCR 文本和结果只保存在内存中，关闭 Obsidian 后消失。",
    });

    new Setting(containerEl)
      .setName("内存缓存条数")
      .setDesc("重复选择相同内容时直接复用结果；设为 0 可关闭。")
      .addSlider((slider) => {
        slider
          .setLimits(0, 200, 10)
          .setValue(this.plugin.settings.cacheSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.cacheSize = value;
            this.plugin.clearCache();
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button.setButtonText("立即清空").onClick(() => {
          this.plugin.clearCache();
          new Notice("日语阅读助手的内存缓存已清空。");
        });
      });
  }
}

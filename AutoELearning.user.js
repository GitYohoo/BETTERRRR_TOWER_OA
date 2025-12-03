// ==UserScript==
// @name         E-Learning全自动刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.7 // 版本号更新：修复 appInitialized 变量重复声明导致的语法错误。
// @description  自动监测课程状态，完成后自动关闭并触发主页点击下一节。整合了自动关闭、自动标记、自动连播功能。
// @author       You
// @match        https://elearning.chinatowercom.cn/*
// @grant        window.close
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    // ================= 配置区域 =================
    const CONFIG = {
        checkInterval: 2000,       // 检查频率 (毫秒)
        nextDelay: 3000,           // 关闭页面后，等待多久点击下一节 (毫秒，太快容易报错)
        storageKeyClicked: 'ct_clicked_ids_v2', // 存储已点课程ID的键名 (普通完成/跳过)
        storageKeyExamCheck: 'ct_exam_check_ids', // 存储需要检查的课程ID (考试含成绩)
        storageKeySignal: 'ct_signal_next',     // 通信信号键名
        storageKeyAutoStart: 'ct_auto_start_state', // 自动开始开关状态键名
        storageKeyLastClicked: 'ct_last_clicked_id', // 上次点击的课程ID (临时存储)
        markColor: '#e8f5e9',      // 普通已读课程背景色 (浅绿)
        borderColor: '#4caf50'     // 普通已读课程边框色 (绿色)
    };

    // 全局状态标志，确保只初始化一次
    let appInitialized = false;

    // ================= 样式注入 =================
    GM_addStyle(`
        /* 已读标记样式 (普通课程) */
        .course-clicked-mark {
            background-color: ${CONFIG.markColor} !important;
            border: 1px solid ${CONFIG.borderColor} !important;
            opacity: 0.8;
            position: relative;
        }
        .course-clicked-mark::after {
            content: '已学/跳过';
            position: absolute;
            top: 0;
            right: 0;
            background: ${CONFIG.borderColor};
            color: white;
            font-size: 10px;
            padding: 2px 6px;
            z-index: 10;
        }
        /* 考试检查标记样式 (新增) */
        .course-exam-check-mark {
            background-color: #ffebee !important; /* 浅红背景 */
            border: 2px solid #f44336 !important; /* 红色粗边框 */
            opacity: 0.9;
            position: relative;
        }
        .course-exam-check-mark::after {
            content: '请检查是否通过考试'; /* 提示内容 */
            position: absolute;
            top: 0;
            right: 0;
            background: #f44336; /* 红色 */
            color: white;
            font-size: 10px;
            padding: 2px 6px;
            z-index: 10;
        }

        /* 自动处理中的提示条 */
        #ct-helper-toast {
            position: fixed;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            background-color: rgba(0, 0, 0, 0.8);
            color: #fff;
            padding: 10px 20px;
            border-radius: 5px;
            font-size: 14px;
            z-index: 999999;
            pointer-events: none;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            min-width: 250px;
            text-align: center;
        }
        /* 开关按钮样式 */
        #ct-auto-start-toggle {
            position: fixed;
            bottom: 50px;
            left: 10px;
            padding: 8px 15px;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            border: none;
            border-radius: 4px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            transition: all 0.3s ease;
            z-index: 99998;
        }
        .ct-start-on {
            background-color: #4caf50; /* 绿色 */
            color: white;
        }
        .ct-start-off {
            background-color: #f44336; /* 红色 */
            color: white;
        }
        /* 重置按钮位置调整 */
        #ct-reset-btn {
            position:fixed;
            bottom:10px;
            right:10px;
            background:red;
            color:white;
            padding:5px;
            font-size:10px;
            cursor:pointer;
            opacity:0.8;
            z-index:99999;
            border-radius: 4px;
        }
    `);

    // ================= 工具函数 =================
    /**
     * 显示通知。如果 duration 为 0 或负数，则永久显示。
     */
    function showToast(msg, duration = 3000) {
        let toast = document.getElementById('ct-helper-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ct-helper-toast';
            document.body.appendChild(toast);
        }
        toast.innerText = msg;
        toast.style.display = 'block';

        // 只有当 duration > 0 时才设置定时隐藏
        if (duration > 0) {
            setTimeout(() => { toast.style.display = 'none'; }, duration);
        }
    }

    function getStorage(key) {
        let val = localStorage.getItem(key);
        // 如果值是 'null' 或 'undefined' 字符串，返回 null
        if (val === 'null' || val === 'undefined') return null;
        try {
            return val ? JSON.parse(val) : null;
        } catch (e) {
             console.error(`[CT助手] 解析存储键 ${key} 失败:`, e);
             return null;
        }
    }

    function setStorage(key, val) {
        localStorage.setItem(key, JSON.stringify(val));
    }

    function getClickedList() {
        return getStorage(CONFIG.storageKeyClicked) || [];
    }

    function addClickedId(id) {
        let list = getClickedList();
        if (!list.includes(id)) {
            list.push(id);
            setStorage(CONFIG.storageKeyClicked, list);
        }
    }

    /**
     * 获取或设置自动刷课开关状态 (默认关闭)
     */
    function getAutoStartState() {
        // 默认状态为 false (关闭)
        return getStorage(CONFIG.storageKeyAutoStart) === true;
    }

    function setAutoStartState(state) {
        setStorage(CONFIG.storageKeyAutoStart, state);
    }

    /**
     * 获取上次点击的课程ID (临时存储)
     */
    function getLastClickedId() {
        return getStorage(CONFIG.storageKeyLastClicked);
    }

    /**
     * 设置上次点击的课程ID (临时存储)
     */
    function setLastClickedId(id) {
        setStorage(CONFIG.storageKeyLastClicked, id);
    }

    /**
     * 获取或设置考试检查课程ID列表
     */
    function getExamCheckList() {
        return getStorage(CONFIG.storageKeyExamCheck) || [];
    }

    function addExamCheckId(id) {
        let list = getExamCheckList();
        if (!list.includes(id)) {
            list.push(id);
            setStorage(CONFIG.storageKeyExamCheck, list);
        }
    }

    /**
     * 获取当前课程 ID
     */
    function getCurrentCourseId() {
        const urlParams = new URLSearchParams(window.location.search);
        // 假设课程 ID 在 URL 的 'id' 参数中
        return urlParams.get('id');
    }

    /**
     * 关闭流程：发送信号并尝试关闭窗口 (更新：增加自动开关判断)
     */
    function triggerCloseSequence(isExamCourse = false) {
        const currentCourseId = getCurrentCourseId();

        // ** 检查自动刷课开关状态 **
        if (!getAutoStartState()) {
            console.log(`[CT助手] 课程ID ${currentCourseId ? currentCourseId.substring(0, 8) : 'Unknown'} 已完成，但自动刷课已关闭，不执行自动关闭操作。`);

            // 提示用户完成，并要求手动关闭
            showToast('课程已完成，但自动刷课已暂停。请手动关闭页面，或开启开关进行自动连播。', 10000);

            // 确保该课程ID被记录为已处理（避免下次自动点击），但不发 NEXT 信号
            if (currentCourseId) {
                // 如果是考试，需要标记为考试检查
                if (isExamCourse) {
                    addExamCheckId(currentCourseId);
                }
                // 无论是普通完成还是考试，都将其加入已点击列表，避免再次被点击
                addClickedId(currentCourseId);
            }
            return; // 退出，不执行后续的关闭和信号发送
        }
        // ** 检查结束，以下只有在自动刷课 ON 时才执行 **

        // 关闭提示需要短暂显示
        showToast('检测到本课程所有子节已完成，3秒后自动关闭并继续...', 5000);

        // 发送信号给主页：可以开始下一节了，并带上是否为考试的标志和课程ID
        setStorage(CONFIG.storageKeySignal, {
            action: 'NEXT',
            time: Date.now(),
            isExam: isExamCourse, // 传递是否为考试课程的标志
            courseId: currentCourseId // 传递当前课程ID
        });

        console.log(`[CT助手] 任务完成，ID: ${currentCourseId}，是否考试: ${isExamCourse}，准备关闭。`);

        // 确保有足够的时间写入 localStorage，然后尝试关闭
        setTimeout(() => {
            // 尝试多种关闭方式，解决浏览器安全限制
            window.opener = null;
            // 尝试打开一个空页面然后关闭（旧版浏览器 hack）
            window.open('', '_self').close();

            // 最终尝试直接关闭
            try {
                window.close();
            } catch (e) {
                console.error('[CT助手] 警告: 浏览器阻止了 window.close()。', e);
                showToast('警告: 无法自动关闭页面，请手动关闭！', 5000);
            }

            // 微信端兼容
            if (window.WeixinJSBridge) window.WeixinJSBridge.call('closeWindow');

        }, 1000);
    }


    // ================= 核心初始化和页面判断 =================

    /**
     * 核心初始化函数：尝试判断页面类型并启动对应逻辑
     */
    function initApp() {
        if (appInitialized) return;

        // 重新检查页面元素，以便适应 SPA 的延迟加载
        const isListPage = document.querySelectorAll('.item[data-resource-id]').length > 0;
        // 学习页通常有具体的章节状态 (.chapter-list-box 或 .course-cover)
        const isLearningPage = document.querySelectorAll('.chapter-list-box').length > 0 || document.querySelector('.course-cover');

        console.log(`[CT助手] 页面判定 -> 主页: ${isListPage}, 学习页: ${isLearningPage}`);

        // 场景一：学习页面 (有学习特有元素，且列表元素不显著)
        if (isLearningPage && !isListPage) {
            appInitialized = true;
            runLearningPageLogic();
        }
        // 场景二：列表主页面 (有大量的 data-resource-id 课程项)
        else if (isListPage) {
            appInitialized = true;
            runListPageLogic();
            // 在主页显示重置按钮
            setTimeout(addResetBtn, 3000);
            // 在主页显示开关按钮
            setTimeout(addStartStopToggle, 3000);
        }
    }

    // 尝试在不同时间点运行初始化，确保抓住 SPA 渲染完成的时刻
    // 0.5s 后第一次尝试
    setTimeout(initApp, 500);
    // 2.5s 后第二次尝试 (应对较慢的加载)
    setTimeout(initApp, 2500);

    // ================= 核心功能实现 =================

    /**
     * 学习页逻辑：检测所有必修子课程是否完成 -> 发信号 -> 关闭
     */
    function runLearningPageLogic() {
        console.log('[CT助手] 启动学习页监听模式...');
        let isClosing = false;
        let hasExamScore = false; // 记录是否发现“成绩”标签

        // 用于防止短时间内重复更新 UI/Toast
        let lastCompletedCount = -1;
        const autoStart = getAutoStartState(); // 仅在学习页启动时检查一次开关状态

        setInterval(() => {
            if (isClosing) return;

            // 查找所有必修的子课程章节容器
            const requiredSections = document.querySelectorAll('dl.chapter-list-box.required');

            // -------------------- 边界处理：单章节 --------------------
            if (requiredSections.length === 0) {
                 // Fallback: 如果是单节必修课，使用遍历查找
                let completedFound = false;
                let statusSpans = document.querySelectorAll('.item22 span');
                statusSpans.forEach(span => {
                    const statusText = span.innerText.trim();
                    if (statusText === '已完成' || statusText.includes('成绩')) {
                         completedFound = true;
                         if (statusText.includes('成绩')) hasExamScore = true; // 记录考试状态
                    }
                });

                if (completedFound) {
                    console.log('[CT助手] (单节判断) 检测到课程已完成，准备关闭。');
                    isClosing = true;
                    triggerCloseSequence(hasExamScore); // 传递考试状态
                }

                return;
            }
            // --------------------------------------------------------


            let completedCount = 0;
            let totalRequired = requiredSections.length;

            requiredSections.forEach(section => {
                let isSectionCompleted = false;

                // 1. 检查明确的“已完成”状态 或 考试“成绩”
                const allStatusSpans = section.querySelectorAll('.item22 span');
                for (let span of allStatusSpans) {
                    const statusText = span.innerText.trim();

                    // 检查 A: 明确的“已完成”
                    if (statusText === '已完成') {
                        isSectionCompleted = true;
                        break;
                    }

                    // 检查 B: 包含“成绩”（用于考试等）
                    if (statusText.includes('成绩')) {
                        isSectionCompleted = true;
                        hasExamScore = true; // 记录考试状态
                        break;
                    }
                }

                // 2. 如果没有明确完成状态，检查百分比进度
                if (!isSectionCompleted) {
                    // 改为遍历所有 <b> 标签，检查是否包含数字和%
                    const allBoldTags = section.querySelectorAll('.section-item b');

                    for (let bTag of allBoldTags) {
                         let text = bTag.innerText.trim();
                         // 匹配结尾是 % 的纯数字文本，例如 "34%", "100%"
                         if (/^\d+%$/.test(text)) {
                             const percent = parseFloat(text.replace('%', ''));
                             if (percent >= 95) {
                                 isSectionCompleted = true;
                             }
                             break; // 找到了百分比标签，判断完就退出循环
                         }
                    }
                }

                if (isSectionCompleted) {
                    completedCount++;
                    section.style.borderLeft = '5px solid #4caf50'; // 加粗绿色标记，方便确认脚本是否识别到了
                } else {
                     section.style.borderLeft = '5px solid #ff9800'; // 橙色标记表示脚本认为“未完成”
                }
            });

            // 仅在自动刷课 ON 时才显示持续进度 Toast
            if (autoStart && completedCount !== lastCompletedCount) {
                lastCompletedCount = completedCount;
                const examText = hasExamScore ? ' (含考试)' : '';
                const newToastMessage = `自动刷课进行中... (进度: ${completedCount}/${totalRequired} 节)${examText}`;
                console.log(`[CT助手] 多章节状态：${newToastMessage}`);
                showToast(newToastMessage, 0); // duration 设置为 0，永久显示
            }

            if (completedCount >= totalRequired) {
                isClosing = true;
                console.log('[CT助手] 检测到所有必修子课程已完成。');
                triggerCloseSequence(hasExamScore); // 传递考试状态
            }

        }, CONFIG.checkInterval);

        // 如果自动刷课关闭，只在加载时提示一次当前状态
        if (!autoStart) {
             showToast('自动刷课已暂停。课程完成不会自动关闭。', 5000);
        }
    }

    /**
     * 主页逻辑：标黄 -> 监听信号 -> 点击下一个
     */
    function runListPageLogic() {
        console.log('[CT助手] 启动主页列表管理模式...');

        // 每次加载主页时，将自动刷课默认设置为关闭状态
        setAutoStartState(false);

        // 每次加载主页时，清空上次点击的临时ID
        setLastClickedId(null);

        // 1. 初始化：标黄已点过的课程
        markClickedCourses();
        setInterval(markClickedCourses, 2000); // 持续补标，防止分页加载

        // 2. 监听信号 (轮询 localStorage)
        // ** V3.5 关键修改: 初始化为当前时间，忽略在此之前的所有旧信号 **
        let lastSignalTime = Date.now();

        setInterval(() => {
            let signal = getStorage(CONFIG.storageKeySignal);

            // 检查是否有新信号 (action 为 NEXT，且时间戳比上次处理的新)
            if (signal && signal.action === 'NEXT' && signal.time > lastSignalTime) {
                console.log('[CT助手] 收到子窗口完成信号，准备进入下一课...');
                lastSignalTime = signal.time; // 更新处理时间，防止重复处理

                // ** V3.5 新增: 收到信号后，立即清除信号，防止刷新页面后重复读取 **
                setStorage(CONFIG.storageKeySignal, null);

                // --- 信号处理逻辑：仅在自动刷课 ON 时才会走到这里 ---

                // 处理考试标记
                if (signal.isExam === true && signal.courseId) {
                    addExamCheckId(signal.courseId); // 加入考试检查列表
                    console.log(`[CT助手] 课程ID ${signal.courseId.substring(0, 8)} 标记为【考试检查】。`);
                }

                // 课程总是被认为“已处理”，加入普通完成列表 (即使是考试，也避免再次点击)
                if (signal.courseId) {
                    addClickedId(signal.courseId);
                }
                // --- 信号处理结束 ---

                // 检查自动刷课开关是否打开 (理论上收到信号时就是打开的，这里是双重保险)
                if (getAutoStartState()) {
                    showToast(`上一课已完成，${CONFIG.nextDelay/1000}秒后自动打开下一课...`);
                    setTimeout(() => {
                        clickNextUnreadCourse();
                    }, CONFIG.nextDelay);
                } else {
                    // 如果在信号处理期间用户关了开关，则暂停
                    console.log('[CT助手] 收到完成信号，但自动刷课已暂停。');
                    showToast('已完成一课，但自动刷课已暂停 (请点击开关继续)', 0);
                }
            }
        }, 1000);

         // 3. 页面加载后立即显示状态
        setTimeout(() => {
            // 注意：由于前面 setAutoStartState(false) 已经执行，这里 getAutoStartState() 必然是 false，除非用户在 1.5s 内点击了开关
            if (getAutoStartState()) {
                 showToast('自动刷课已开启，尝试点击未读课程...', 0);
                 // 自动开始刷课
                 clickNextUnreadCourse();
            } else {
                 showToast('自动刷课已暂停 (请点击开关启动)', 0);
            }
        }, 1500);
    }

    /**
     * 辅助：遍历列表并标黄 (更新：优先检查考试标记)
     */
    function markClickedCourses() {
        let items = document.querySelectorAll('.item[data-resource-id]');
        let clickedList = getClickedList();
        let examCheckList = getExamCheckList(); // 获取考试检查列表
        let listUpdated = false;

        items.forEach(item => {
            let rid = item.getAttribute('data-resource-id');
            if (!rid) return;

            // --- 优先检查：是否为需要【检查考试】的课程 ---
            if (examCheckList.includes(rid)) {
                item.classList.remove('course-clicked-mark'); // 移除普通标记
                if (!item.classList.contains('course-exam-check-mark')) {
                    item.classList.add('course-exam-check-mark'); // 添加红色检查标记
                }
                return; // 考试标记优先级最高，跳过后续检查
            } else {
                // 如果在列表，但课程现在显示“重新学习”，则移除考试标记（理论上不该发生）
                 item.classList.remove('course-exam-check-mark');
            }


            // --- 第二检查：是否为【已完成/重新学习】的课程 ---
            const isCompletedVisually = item.querySelector('.operation .small.inline-block') &&
                                       item.querySelector('.operation .small.inline-block').innerText.trim() === '重新学习';

            if (isCompletedVisually) {
                // 1. 强制应用视觉标记 (Green/Default)
                if (!item.classList.contains('course-clicked-mark')) {
                    item.classList.add('course-clicked-mark');
                }
                // 2. 强制加入 internal clicked list (作为黑名单，确保不再点击)
                if (!clickedList.includes(rid)) {
                    addClickedId(rid);
                    listUpdated = true;
                }
            }
            // 兼容性检查：如果ID在clickedList中（可能是以前手动跳过的），也应该标记。
            else if (clickedList.includes(rid)) {
                // 如果在历史记录中，但没有“重新学习”标记，则保持视觉标记
                if (!item.classList.contains('course-clicked-mark')) {
                    item.classList.add('course-clicked-mark');
                }
            } else {
                 // 既没有完成标记，也不在历史记录，移除视觉标记（确保干净）
                item.classList.remove('course-clicked-mark');
            }


            // 绑定点击事件 (用于手动点击时，只做日志记录)
            if (item.getAttribute('data-monitor') !== 'true') {
                item.addEventListener('click', function() {
                    console.log(`[CT助手] 手动点击课程: ${rid} (不自动加入记录)`);
                });
                item.setAttribute('data-monitor', 'true');
            }
        });

        if (listUpdated) {
             console.log('[CT助手] 发现新的已完成课程（包含“重新学习”），已更新记录。');
        }
    }

    /**
     * 核心：寻找并点击下一个未读课程
     */
    function clickNextUnreadCourse() {
        // 关键判断：检查开关状态
        if (!getAutoStartState()) {
            console.log('[CT助手] 自动刷课开关关闭，跳过点击操作。');
            showToast('自动刷课已暂停 (开关关闭)', 0);
            return;
        }

        let items = document.querySelectorAll('.item[data-resource-id]');
        let targetItem = null;
        let lastClickedId = getLastClickedId(); // 获取上次点击的ID

        // 遍历所有课程，找到第一个符合条件的课程
        for (let item of items) {
            let rid = item.getAttribute('data-resource-id');

            // 1. 检查防抖：如果该ID是上次点击的，且页面尚未刷新状态，则跳过
            if (rid === lastClickedId) {
                console.log(`[CT助手] 避免重复点击: ${rid.substring(0, 8)} (上次点击的ID)`);
                continue;
            }

            // 2. 检查标记：跳过已完成标记或考试检查标记的课程
            if (item.classList.contains('course-clicked-mark') || item.classList.contains('course-exam-check-mark')) {
                continue;
            }

            // 3. 【新增检查】检查课程文本是否包含考试相关关键词 (防止点击非视频/文档课件)
            const itemText = (item.innerText || item.textContent).trim();
            if (itemText.includes('参与考试') || itemText.includes('考试记录')) {
                console.log(`[CT助手] 跳过课程: ${rid.substring(0, 8)} - 识别为考试类课程.`);
                continue;
            }

            // 4. 找到目标
            targetItem = item;
            break; // 找到了，停止循环
        }

        if (targetItem) {
            let rid = targetItem.getAttribute('data-resource-id');
            showToast(`自动刷课：正在打开课程 ID: ${rid.substring(0, 8)}...`, 0);
            console.log(`[CT助手] 自动点击下一课: ${rid}`);

            // 点击前，将该课程ID设为上次点击的临时ID
            setLastClickedId(rid);

            // 1. 滚动到该元素
            targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // 2. 模拟点击
            setTimeout(() => {
                targetItem.click();
            }, 500);

        } else {
            showToast('未找到未读课程，本页可能已全部完成！', 0);
            console.log('[CT助手] 没有找到未读课程。可能是翻页了，或者全部学完了。');
        }
    }

    /**
     * 新增：自动刷课开关按钮
     */
    function addStartStopToggle() {
        let btn = document.getElementById('ct-auto-start-toggle');
        if (btn) return; // 避免重复创建

        let isAutoStart = getAutoStartState();

        btn = document.createElement('button');
        btn.id = 'ct-auto-start-toggle';

        // 辅助函数：更新按钮的文本和样式
        const updateButtonUI = (state) => {
            btn.innerText = state ? '自动刷课 ON (点击暂停)' : '自动刷课 OFF (点击开始)';
            btn.className = state ? 'ct-start-on' : 'ct-start-off';
        };

        // 初始化UI
        updateButtonUI(isAutoStart);

        // 点击事件处理
        btn.onclick = () => {
            isAutoStart = !isAutoStart;
            setAutoStartState(isAutoStart);
            updateButtonUI(isAutoStart);

            if (isAutoStart) {
                console.log('[CT助手] 开关已开启，立即尝试点击下一课。');
                showToast('自动刷课已启动！', 0);
                // 开启时清空临时ID，确保能立即开始
                setLastClickedId(null);
                // 立即尝试开始刷课
                clickNextUnreadCourse();
            } else {
                console.log('[CT助手] 开关已关闭，自动刷课暂停。');
                showToast('自动刷课已暂停 (开关关闭)', 0);
            }
        };

        document.body.appendChild(btn);
    }

    // 清理数据的按钮 (方便测试)
    function addResetBtn() {
        let btn = document.createElement('div');
        btn.id = 'ct-reset-btn'; // 添加ID
        btn.innerText = '重置记录 (v3.7)';

        btn.onclick = () => {
            if(confirm('确定清除所有已学记录、考试检查标记和开关状态吗？')) {
                localStorage.removeItem(CONFIG.storageKeyClicked);
                localStorage.removeItem(CONFIG.storageKeySignal);
                localStorage.removeItem(CONFIG.storageKeyAutoStart);
                localStorage.removeItem(CONFIG.storageKeyExamCheck);
                localStorage.removeItem(CONFIG.storageKeyLastClicked); // 清除临时ID
                location.reload();
            }
        };
        document.body.appendChild(btn);
    }

})();
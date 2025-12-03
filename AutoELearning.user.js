// ==UserScript==
// @name         中国铁塔E-Learning全自动刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.8 // 版本号更新：代码重构优化 (内存管理、超时保护、常量提取、日志封装)
// @description  自动监测课程状态，完成后自动关闭并触发主页点击下一节。整合了自动关闭、自动标黄、自动连播功能。
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
        DEBUG: true,               // 是否显示调试日志
        checkInterval: 2000,       // 检查频率 (毫秒)
        nextDelay: 3000,           // 关闭页面后，等待多久点击下一节 (毫秒)
        maxWaitTime: 120 * 60 * 1000, // 学习页最大等待时间 (20分钟)，超时强制关闭
        storageKeyClicked: 'ct_clicked_ids_v2', // 存储已点课程ID的键名
        storageKeyExamCheck: 'ct_exam_check_ids', // 存储需要检查的课程ID
        storageKeySignal: 'ct_signal_next',     // 通信信号键名
        storageKeyAutoStart: 'ct_auto_start_state', // 自动开始开关状态键名
        storageKeyLastClicked: 'ct_last_clicked_id', // 上次点击的课程ID
        markColor: '#e8f5e9',      // 普通已读课程背景色 (浅绿)
        borderColor: '#4caf50'     // 普通已读课程边框色 (绿色)
    };

    // 文本常量提取，便于维护
    const TEXT = {
        COMPLETED: '已完成',
        SCORE: '成绩',
        REDO: '重新学习',
        EXAM_JOIN: '参与考试',
        EXAM_RECORD: '考试记录'
    };

    // 全局变量
    let appInitialized = false;
    let learningIntervalId = null;
    let listIntervalId = null;

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
        /* 考试检查标记样式 */
        .course-exam-check-mark {
            background-color: #ffebee !important; /* 浅红背景 */
            border: 2px solid #f44336 !important; /* 红色粗边框 */
            opacity: 0.9;
            position: relative;
        }
        .course-exam-check-mark::after {
            content: '请检查是否通过考试';
            position: absolute;
            top: 0;
            right: 0;
            background: #f44336; /* 红色 */
            color: white;
            font-size: 10px;
            padding: 2px 6px;
            z-index: 10;
        }
        /* 提示条 */
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
            background-color: #4caf50; color: white;
        }
        .ct-start-off {
            background-color: #f44336; color: white;
        }
        /* 重置按钮 */
        #ct-reset-btn {
            position:fixed; bottom:10px; right:10px; 
            background:red; color:white; padding:5px; 
            font-size:10px; cursor:pointer; opacity:0.8; 
            z-index:99999; border-radius: 4px;
        }
    `);

    // ================= 工具函数 =================
    
    // 统一日志输出
    function debugLog(msg) {
        if (CONFIG.DEBUG) console.log(`[CT助手] ${msg}`);
    }

    function showToast(msg, duration = 3000) {
        let toast = document.getElementById('ct-helper-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ct-helper-toast';
            document.body.appendChild(toast);
        }
        toast.innerText = msg;
        toast.style.display = 'block';
        if (duration > 0) {
            setTimeout(() => { toast.style.display = 'none'; }, duration);
        }
    }

    function getStorage(key) {
        try {
            let val = localStorage.getItem(key);
            if (val === 'null' || val === 'undefined') return null;
            return val ? JSON.parse(val) : null;
        } catch (e) {
            console.error(`[CT助手] 存储读取异常 ${key}:`, e);
            return null;
        }
    }

    function setStorage(key, val) {
        try {
            localStorage.setItem(key, JSON.stringify(val));
        } catch (e) {
            console.error(`[CT助手] 存储写入异常 ${key}:`, e);
        }
    }

    function getClickedList() { return getStorage(CONFIG.storageKeyClicked) || []; }
    function addClickedId(id) {
        let list = getClickedList();
        if (!list.includes(id)) {
            list.push(id);
            setStorage(CONFIG.storageKeyClicked, list);
        }
    }

    function getAutoStartState() { return getStorage(CONFIG.storageKeyAutoStart) === true; }
    function setAutoStartState(state) { setStorage(CONFIG.storageKeyAutoStart, state); }
    
    function getLastClickedId() { return getStorage(CONFIG.storageKeyLastClicked); }
    function setLastClickedId(id) { setStorage(CONFIG.storageKeyLastClicked, id); }
    
    function getExamCheckList() { return getStorage(CONFIG.storageKeyExamCheck) || []; }
    function addExamCheckId(id) {
        let list = getExamCheckList();
        if (!list.includes(id)) {
            list.push(id);
            setStorage(CONFIG.storageKeyExamCheck, list);
        }
    }

    function getCurrentCourseId() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('id');
    }

    // ================= 逻辑流控制 =================

    /**
     * 关闭流程：发送信号并尝试关闭窗口
     */
    function triggerCloseSequence(isExamCourse = false, isTimeout = false) {
        // 清理定时器，防止重复触发
        if (learningIntervalId) clearInterval(learningIntervalId);

        const currentCourseId = getCurrentCourseId();

        // 检查开关状态 (如果是超时强制关闭，则忽略开关状态，因为这是保护机制)
        if (!getAutoStartState() && !isTimeout) {
            debugLog(`课程ID ${currentCourseId || 'Unknown'} 完成，但自动刷课已关闭。`);
            showToast('课程已完成，但自动刷课已暂停。请手动关闭或开启自动连播。', 10000);
            
            if (currentCourseId) {
                if (isExamCourse) addExamCheckId(currentCourseId);
                addClickedId(currentCourseId); 
            }
            return;
        }

        const msg = isTimeout ? '检测到页面超时，尝试自动处理并继续...' : '检测到本课程完成，3秒后自动关闭...';
        showToast(msg, 5000);
        
        // 发送信号
        setStorage(CONFIG.storageKeySignal, { 
            action: 'NEXT', 
            time: Date.now(),
            isExam: isExamCourse, 
            courseId: currentCourseId 
        });

        debugLog(`任务结束 (ID: ${currentCourseId}, 考试: ${isExamCourse}, 超时: ${isTimeout})，准备关闭。`);

        setTimeout(() => {
            window.opener = null;
            window.open('', '_self').close();
            try { window.close(); } catch (e) { 
                console.error('[CT助手] 关闭失败:', e);
                showToast('警告: 无法自动关闭页面！', 5000);
            }
            if (window.WeixinJSBridge) window.WeixinJSBridge.call('closeWindow');
        }, 1000);
    }

    // ================= 初始化 =================

    function initApp() {
        if (appInitialized) return;

        // 增强的页面判断逻辑
        const hasListItems = document.querySelectorAll('.item[data-resource-id]').length > 0;
        const hasChapterBox = document.querySelectorAll('.chapter-list-box').length > 0;
        const hasCourseCover = document.querySelector('.course-cover');
        
        // URL 辅助判断
        const isUrlLearning = window.location.href.includes('/learning/'); // 假设URL特征，视实际情况而定

        const isListPage = hasListItems && !hasChapterBox; 
        const isLearningPage = hasChapterBox || hasCourseCover || isUrlLearning;

        debugLog(`页面判定 -> 主页: ${isListPage}, 学习页: ${isLearningPage}`);

        if (isLearningPage && !isListPage) { 
            appInitialized = true;
            runLearningPageLogic();
        } else if (isListPage) {
            appInitialized = true;
            runListPageLogic();
            setTimeout(addResetBtn, 3000);
            setTimeout(addStartStopToggle, 3000);
        }
    }

    // 多次尝试初始化，适应 SPA
    setTimeout(initApp, 500); 
    setTimeout(initApp, 2500); 

    // ================= 核心功能实现 =================

    /**
     * 学习页逻辑
     */
    function runLearningPageLogic() {
        debugLog('启动学习页监听模式...');
        
        let lastCompletedCount = -1;
        const autoStart = getAutoStartState(); 
        const startTime = Date.now(); // 记录开始时间用于超时判断

        if (!autoStart) {
             showToast('自动刷课已暂停。课程完成不会自动关闭。', 5000);
        }

        // 保存定时器ID
        learningIntervalId = setInterval(() => {
            // 1. 超时检查
            if (Date.now() - startTime > CONFIG.maxWaitTime) {
                console.warn('[CT助手] 页面停留时间过长，触发超时保护。');
                triggerCloseSequence(false, true); // 触发超时关闭流程
                return;
            }

            // 2. 查找必修章节
            const requiredSections = document.querySelectorAll('dl.chapter-list-box.required');
            let hasExamScore = false;

            // 边界：单章节处理
            if (requiredSections.length === 0) {
                let completedFound = false;
                const statusSpans = document.querySelectorAll('.item22 span');
                for (const span of statusSpans) {
                    const text = span.innerText.trim();
                    if (text === TEXT.COMPLETED || text.includes(TEXT.SCORE)) {
                         completedFound = true;
                         if (text.includes(TEXT.SCORE)) hasExamScore = true;
                         break;
                    }
                }

                if (completedFound) {
                    debugLog('(单节) 检测到完成');
                    triggerCloseSequence(hasExamScore);
                }
                return;
            }

            // 多章节处理
            let completedCount = 0;
            let totalRequired = requiredSections.length;
            
            requiredSections.forEach(section => {
                let isSectionCompleted = false;
                
                // 检查状态文本
                const statusSpans = section.querySelectorAll('.item22 span');
                for (const span of statusSpans) {
                    const text = span.innerText.trim();
                    if (text === TEXT.COMPLETED) {
                        isSectionCompleted = true; break;
                    }
                    if (text.includes(TEXT.SCORE)) {
                        isSectionCompleted = true; hasExamScore = true; break;
                    }
                }
                
                // 检查百分比
                if (!isSectionCompleted) {
                    const boldTags = section.querySelectorAll('.section-item b');
                    for (const bTag of boldTags) {
                         let text = bTag.innerText.trim();
                         if (/^\d+%$/.test(text)) {
                             const percent = parseFloat(text.replace('%', ''));
                             if (percent >= 95) isSectionCompleted = true;
                             break;
                         }
                    }
                }

                if (isSectionCompleted) {
                    completedCount++;
                    section.style.borderLeft = `5px solid ${CONFIG.borderColor}`;
                } else {
                     section.style.borderLeft = '5px solid #ff9800';
                }
            });
            
            // 更新提示
            if (autoStart && completedCount !== lastCompletedCount) {
                lastCompletedCount = completedCount;
                const examText = hasExamScore ? ' (含考试)' : '';
                const msg = `自动刷课进行中... (进度: ${completedCount}/${totalRequired} 节)${examText}`;
                debugLog(msg);
                showToast(msg, 0);
            }

            if (completedCount >= totalRequired) {
                triggerCloseSequence(hasExamScore);
            }

        }, CONFIG.checkInterval);
    }

    /**
     * 主页逻辑
     */
    function runListPageLogic() {
        debugLog('启动主页列表管理模式...');
        
        setAutoStartState(false); // 默认关闭
        setLastClickedId(null);   // 清空临时ID
        
        markClickedCourses();
        setInterval(markClickedCourses, 2000); 

        let lastSignalTime = Date.now(); // 忽略旧信号

        listIntervalId = setInterval(() => {
            let signal = getStorage(CONFIG.storageKeySignal);
            
            if (signal && signal.action === 'NEXT' && signal.time > lastSignalTime) {
                debugLog('收到完成信号...');
                lastSignalTime = signal.time;
                
                // 立即销毁信号，防止竞态条件
                setStorage(CONFIG.storageKeySignal, null);
                
                // 标记处理
                if (signal.isExam === true && signal.courseId) { 
                    addExamCheckId(signal.courseId);
                    debugLog(`课程ID ${signal.courseId.substring(0, 8)} 标记为考试检查。`);
                }
                if (signal.courseId) {
                    addClickedId(signal.courseId); 
                }

                if (getAutoStartState()) {
                    showToast(`上一课已完成，${CONFIG.nextDelay/1000}秒后继续...`);
                    setTimeout(clickNextUnreadCourse, CONFIG.nextDelay);
                } else {
                    debugLog('自动刷课已暂停');
                    showToast('已完成一课，自动刷课已暂停', 0);
                }
            }
        }, 1000);
        
        setTimeout(() => {
            if (getAutoStartState()) {
                 showToast('自动刷课已开启...', 0);
                 clickNextUnreadCourse();
            } else {
                 showToast('自动刷课已暂停 (请点击开关启动)', 0);
            }
        }, 1500); 
    }

    /**
     * 标记逻辑
     */
    function markClickedCourses() {
        let items = document.querySelectorAll('.item[data-resource-id]');
        let clickedList = getClickedList();
        let examCheckList = getExamCheckList();

        items.forEach(item => {
            let rid = item.getAttribute('data-resource-id');
            if (!rid) return;

            // 优先级1：考试检查
            if (examCheckList.includes(rid)) {
                item.classList.remove('course-clicked-mark');
                if (!item.classList.contains('course-exam-check-mark')) {
                    item.classList.add('course-exam-check-mark');
                }
                return;
            } else {
                 item.classList.remove('course-exam-check-mark');
            }

            // 优先级2：已完成/重新学习
            const redoBtn = item.querySelector('.operation .small.inline-block');
            const isCompletedVisually = redoBtn && redoBtn.innerText.trim() === TEXT.REDO;

            if (isCompletedVisually) {
                if (!item.classList.contains('course-clicked-mark')) {
                    item.classList.add('course-clicked-mark');
                }
                if (!clickedList.includes(rid)) {
                    addClickedId(rid);
                }
            } else if (clickedList.includes(rid)) {
                if (!item.classList.contains('course-clicked-mark')) {
                    item.classList.add('course-clicked-mark');
                }
            } else {
                item.classList.remove('course-clicked-mark');
            }

            // 绑定手动点击监控
            if (item.getAttribute('data-monitor') !== 'true') {
                item.addEventListener('click', () => {
                    debugLog(`手动点击: ${rid}`);
                });
                item.setAttribute('data-monitor', 'true');
            }
        });
    }

    /**
     * 点击逻辑
     */
    function clickNextUnreadCourse() {
        if (!getAutoStartState()) {
            debugLog('开关关闭，停止点击');
            showToast('自动刷课已暂停 (开关关闭)', 0);
            return;
        }

        let items = document.querySelectorAll('.item[data-resource-id]');
        let targetItem = null;
        let lastClickedId = getLastClickedId();

        for (let item of items) {
            let rid = item.getAttribute('data-resource-id');

            // 防抖
            if (rid === lastClickedId) {
                debugLog(`防抖跳过: ${rid.substring(0, 8)}`);
                continue; 
            }

            // 跳过已完成或需检查的
            if (item.classList.contains('course-clicked-mark') || item.classList.contains('course-exam-check-mark')) {
                continue;
            }
            
            // 跳过考试入口
            const itemText = (item.innerText || item.textContent).trim();
            if (itemText.includes(TEXT.EXAM_JOIN) || itemText.includes(TEXT.EXAM_RECORD)) {
                debugLog(`跳过考试类课程: ${rid.substring(0, 8)}`);
                continue;
            }

            targetItem = item;
            break; 
        }

        if (targetItem) {
            let rid = targetItem.getAttribute('data-resource-id');
            showToast(`正在打开课程...`, 0);
            debugLog(`自动点击: ${rid}`);
            
            setLastClickedId(rid);
            targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            setTimeout(() => { targetItem.click(); }, 500);
        } else {
            showToast('本页可能已全部完成！', 0); 
            debugLog('未找到可点击课程');
        }
    }

    // UI 组件：开关按钮
    function addStartStopToggle() {
        if (document.getElementById('ct-auto-start-toggle')) return;

        let isAutoStart = getAutoStartState();
        let btn = document.createElement('button');
        btn.id = 'ct-auto-start-toggle';
        
        const updateUI = (state) => {
            btn.innerText = state ? '自动刷课 ON (点击暂停)' : '自动刷课 OFF (点击开始)';
            btn.className = state ? 'ct-start-on' : 'ct-start-off';
        };
        updateUI(isAutoStart);

        btn.onclick = () => {
            isAutoStart = !isAutoStart;
            setAutoStartState(isAutoStart);
            updateUI(isAutoStart);
            
            if (isAutoStart) {
                showToast('自动刷课已启动！', 0);
                setLastClickedId(null); 
                clickNextUnreadCourse();
            } else {
                showToast('自动刷课已暂停', 0);
            }
        };
        document.body.appendChild(btn);
    }

    // UI 组件：重置按钮
    function addResetBtn() {
        let btn = document.createElement('div');
        btn.id = 'ct-reset-btn';
        btn.innerText = '重置记录 (v3.8)';
        
        btn.onclick = () => {
            if(confirm('确定清除所有记录吗？')) {
                Object.values(CONFIG).forEach(val => {
                    if (typeof val === 'string' && val.startsWith('ct_')) {
                        localStorage.removeItem(val);
                    }
                });
                location.reload();
            }
        };
        document.body.appendChild(btn);
    }

})();